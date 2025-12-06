var events = require('events');
var crypto = require('crypto');

var bignum = require('bignum');

var util = require('./util.js');
var blockTemplate = require('./blockTemplate.js');
var nu5BlockTemplate = require('./nu5BlockTemplate.js');

const EH_PARAMS_MAP = {
    "125_4": {
        SOLUTION_LENGTH: 106,
        SOLUTION_SLICE: 2,
    },
    "144_5": {
        SOLUTION_LENGTH: 202,
        SOLUTION_SLICE: 2,
    },
    "192_7": {
        SOLUTION_LENGTH: 806,
        SOLUTION_SLICE: 6,
    },
    "200_9": {
        SOLUTION_LENGTH: 2694,
        SOLUTION_SLICE: 6,
    }
}

//Unique extranonce per subscriber
var ExtraNonceCounter = function (configInstanceId) {
    var instanceId = configInstanceId || crypto.randomBytes(4).readUInt32LE(0);
    var counter = instanceId << 27;
    this.next = function () {
        var extraNonce = util.packUInt32BE(Math.abs(counter++));
        return extraNonce.toString('hex');
    };
    this.size = 4; //bytes
};

//Unique job per new block template
var JobCounter = function () {
    var counter = 0x0000cccc;

    this.next = function () {
        counter++;
        if (counter % 0xffffffffff === 0)
            counter = 1;
        return this.cur();
    };

    this.cur = function () {
        return counter.toString(16);
    };
};
function isHexString(s) {
    var check = String(s).toLowerCase();
    if(check.length % 2) {
        return false;
    }
    for (i = 0; i < check.length; i=i+2) {
        var c = check[i] + check[i+1];
        if (!isHex(c))
            return false;
    }
    return true;
}
function isHex(c) {
    var a = parseInt(c,16);
    var b = a.toString(16).toLowerCase();
    if(b.length % 2) {
        b = '0' + b;
    }
    if (b !== c) {
        return false;
    }
    return true;
}

function decodeCompactSolution(solnHex) {
    var solnBuf;
    try {
        solnBuf = Buffer.from(solnHex, 'hex');
    } catch (e) {
        return {error: 'solution is not valid hex'};
    }
    if (solnBuf.length < 1) {
        return {error: 'solution is empty'};
    }

    var prefix = solnBuf[0];
    var offset = 1;
    var solnSize;

    if (prefix < 253) {
        solnSize = prefix;
    } else if (prefix === 253) {
        if (solnBuf.length < 3) return {error: 'solution length prefix truncated'};
        solnSize = solnBuf.readUInt16LE(1);
        offset = 3;
    } else if (prefix === 254) {
        if (solnBuf.length < 5) return {error: 'solution length prefix truncated'};
        solnSize = solnBuf.readUInt32LE(1);
        offset = 5;
    } else {
        return {error: 'solution length prefix too large'};
    }

    if (solnBuf.length !== offset + solnSize) {
        return {error: 'Error: Incorrect size of solution (' + solnBuf.length * 2 + '), expected ' + (offset + solnSize) * 2};
    }

    return {
        raw: solnBuf,
        solution: solnBuf.slice(offset),
        offsetHex: offset * 2
    };
}

/**
 * Emits:
 * - newBlock(blockTemplate) - When a new block (previously unknown to the JobManager) is added, use this event to broadcast new jobs
 * - share(shareData, blockHex) - When a worker submits a share. It will have blockHex if a block was found
 **/
var JobManager = module.exports = function JobManager(options) {


    //private members

    var _this = this;
    var jobCounter = new JobCounter();

    var shareMultiplier = algos[options.coin.algorithm].multiplier;
    var isZebraNu5 = options.coin && options.coin.useZGetMiningJob;

    //public members

    this.extraNonceCounter = new ExtraNonceCounter(options.instanceId);

    this.currentJob;
    this.validJobs = {};

    var hashDigest = algos[options.coin.algorithm].hash(options.coin);

    var coinbaseHasher = (function () {
        switch (options.coin.algorithm) {
            default:
                return util.sha256d;
        }
    })();


    var blockHasher = (function () {
        switch (options.coin.algorithm) {
            case 'sha1':
                return function (d) {
                    return util.reverseBuffer(util.sha256d(d));
                };
            default:
                return function (d) {
                    return util.reverseBuffer(util.sha256(d));
                };
        }
    })();

    function buildTemplate(rpcData) {
        if (isZebraNu5 || rpcData.header_pre_nonce_solution) {
            // Use a short local job id for miners, keep the node-provided id for internal reference
            var localJobId = jobCounter.next();
            rpcData.remote_job_id = rpcData.job_id || localJobId;
            rpcData.job_id = localJobId;
            return new nu5BlockTemplate(
                localJobId,
                rpcData,
                options.coin
            );
        }

        return new blockTemplate(
            jobCounter.next(),
            rpcData,
            _this.extraNoncePlaceholder,
            options.recipients,
            options.address,
            options.poolHex,
            options.coin,
            options.daemon
        );
    }

    this.updateCurrentJob = async function (rpcData) {
        var tmpBlockTemplate = buildTemplate(rpcData);
        if (!isZebraNu5 && rpcData.version == 3 && (options.coin.symbol == "zen" || options.coin.symbol == "zent")) {
            await tmpBlockTemplate.calculateTrees();
        }

        _this.currentJob = tmpBlockTemplate;

        _this.emit('updatedBlock', tmpBlockTemplate, true);

        _this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

    };

    //returns true if processed a new block
    this.processTemplate = async function (rpcData) {

        if (isZebraNu5) {
            var prevHash = rpcData.prevhash || rpcData.previousblockhash;
            var currentPrevHash = _this.currentJob && _this.currentJob.rpcData ? _this.currentJob.rpcData.previousblockhash : undefined;
            var isNewNu5Block = typeof (_this.currentJob) === 'undefined' || currentPrevHash !== prevHash;

            var nu5Template = buildTemplate(rpcData);
            _this.currentJob = nu5Template;

            if (isNewNu5Block) {
                this.validJobs = {};
                _this.emit('newBlock', nu5Template);
            } else {
                _this.emit('updatedBlock', nu5Template, true);
            }

            this.validJobs[nu5Template.jobId] = nu5Template;

            return isNewNu5Block;
        }

        /* Block is new if A) its the first block we have seen so far or B) the blockhash is different and the
         block height is greater than the one we have */
        var isNewBlock = typeof(_this.currentJob) === 'undefined';
        if (!isNewBlock && _this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) {
            isNewBlock = true;

            //If new block is outdated/out-of-sync than return
            if (rpcData.height < _this.currentJob.rpcData.height)
                return false;
        }

        if (!isNewBlock) return false;


        var tmpBlockTemplate = buildTemplate(rpcData);
        if (rpcData.version == 3 && (options.coin.symbol == "zen" || options.coin.symbol == "zent")) {
            await tmpBlockTemplate.calculateTrees();
        }

        this.currentJob = tmpBlockTemplate;

        this.validJobs = {};
        _this.emit('newBlock', tmpBlockTemplate);

        this.validJobs[tmpBlockTemplate.jobId] = tmpBlockTemplate;

        return true;

    };

    this.processShare = function (jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln) {
        var shareError = function (error) {
            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                worker: workerName,
                difficulty: difficulty,
                error: error[1]
            });
            return {error: error, result: null};
        };

        if (isZebraNu5) {
            var nu5Job = this.validJobs[jobId];

            if (typeof nu5Job === 'undefined' || nu5Job.jobId != jobId) {
                return shareError([21, 'job not found']);
            }

            if (nTime.length !== 8) {
                return shareError([20, 'incorrect size of ntime']);
            }

            if (nonce.length !== 64) {
                return shareError([20, 'incorrect size of nonce']);
            }

            var parametersNu5 = options.coin.parameters || {
                N: 200,
                K: 9,
                personalization: 'ZcashPoW'
            };

            var Nnu5 = parametersNu5.N || 200;
            var Knu5 = parametersNu5.K || 9;
            var expectedNu5Length = EH_PARAMS_MAP[`${Nnu5}_${Knu5}`].SOLUTION_LENGTH || 2694;
            var nu5SolutionSlice = EH_PARAMS_MAP[`${Nnu5}_${Knu5}`].SOLUTION_SLICE || 0;

            var decodedNu5Soln = decodeCompactSolution(soln);
            if (decodedNu5Soln.error) {
                return shareError([20, decodedNu5Soln.error]);
            }
            if (soln.length !== expectedNu5Length && decodedNu5Soln.raw.length * 2 !== expectedNu5Length) {
                return shareError([20, 'Error: Incorrect size of solution (' + soln.length + '), expected ' + expectedNu5Length]);
            }

            if (!isHexString(extraNonce2)) {
                return shareError([20, 'invalid hex in extraNonce2']);
            }

            if (!nu5Job.registerSubmit(nonce, soln)) {
                return shareError([22, 'duplicate share']);
            }

            var nu5HeaderBuffer = nu5Job.serializeHeader(nonce);
            var nu5SolnBuffer = decodedNu5Soln.raw;
            var nu5HeaderSolnBuffer = Buffer.concat([nu5HeaderBuffer, nu5SolnBuffer]);

            var nu5HeaderHash = util.sha256d(nu5HeaderSolnBuffer);
            var nu5HeaderBigNum = bignum.fromBuffer(nu5HeaderHash, {endian: 'little', size: 32});

            var nu5BlockHashInvalid;
            var nu5BlockHash;
            var nu5BlockHex;

            var nu5ShareDiff = diff1 / nu5HeaderBigNum.toNumber() * shareMultiplier;
            var nu5BlockDiffAdjusted = nu5Job.difficulty * shareMultiplier;

            var nu5SolutionForHash = decodedNu5Soln.solution || new Buffer(soln.slice(nu5SolutionSlice), 'hex');
            if (hashDigest(nu5HeaderBuffer, nu5SolutionForHash) !== true) {
                return shareError([20, 'invalid solution']);
            }

            if (nu5HeaderBigNum.le(nu5Job.target)) {
                nu5BlockHex = nu5Job.serializeBlock(nu5HeaderBuffer, nu5SolnBuffer).toString('hex');
                nu5BlockHash = util.reverseBuffer(nu5HeaderHash).toString('hex');
            } else {
                if (options.emitInvalidBlockHashes)
                    nu5BlockHashInvalid = util.reverseBuffer(util.sha256d(nu5HeaderSolnBuffer)).toString('hex');

                if (nu5ShareDiff / difficulty < 0.99) {

                    if (previousDifficulty && nu5ShareDiff >= previousDifficulty) {
                        difficulty = previousDifficulty;
                    }
                    else {
                        return shareError([23, 'low difficulty share of ' + nu5ShareDiff]);
                    }

                }
            }

            _this.emit('share', {
                job: jobId,
                ip: ipAddress,
                port: port,
                worker: workerName,
                height: nu5Job.rpcData.height,
                blockReward: nu5Job.rpcData.reward,
                difficulty: difficulty,
                prevHash: nu5Job.rpcData.prevhash || nu5Job.rpcData.previousblockhash,
                shareDiff: nu5ShareDiff.toFixed(8),
                blockDiff: nu5BlockDiffAdjusted,
                blockDiffActual: nu5Job.difficulty,
                blockHash: nu5BlockHash,
                blockHashInvalid: nu5BlockHashInvalid
            }, nu5BlockHex);

            return {result: true, error: null, blockHash: nu5BlockHash};
        }

        //console.log('processShare ck1: ', jobId, previousDifficulty, difficulty, extraNonce1, extraNonce2, nTime, nonce, ipAddress, port, workerName, soln)

        var submitTime = Date.now() / 1000 | 0;

        var job = this.validJobs[jobId];

        if (typeof job === 'undefined' || job.jobId != jobId) {
            // console.log('job not found');
            return shareError([21, 'job not found']);
        }

        if (nTime.length !== 8) {
            // console.log('incorrect size of ntime');
            return shareError([20, 'incorrect size of ntime']);
        }

        let nTimeInt = parseInt(nTime.substr(6, 2) + nTime.substr(4, 2) + nTime.substr(2, 2) + nTime.substr(0, 2), 16)

        if (Number.isNaN(nTimeInt)) {
            // console.log('Invalid nTime: ', nTimeInt, nTime)
            return shareError([20, 'invalid ntime'])
        }

        if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
            // console.log('ntime out of range !(', submitTime + 7200, '<', nTimeInt, '<', job.rpcData.curtime, ') original: ', nTime)
            return shareError([20, 'ntime out of range'])
        }

        // console.log(
        //     'ntime', nTime,
        //     'buffered', util.reverseBuffer(new Buffer(nTime, 'hex')),
        //     'inted', parseInt(util.reverseBuffer(new Buffer(nTime, 'hex')).toString('hex'), 16),
        //     'nTimeInt', nTimeInt,
        //     '(', submitTime + 7200, '<', nTimeInt, '<', job.rpcData.curtime, ')'
        // )

        //console.log('processShare ck3')

        if (nonce.length !== 64) {
            // console.log('incorrect size of nonce');
            return shareError([20, 'incorrect size of nonce']);
        }

        /**
         * TODO: This is currently accounting only for equihash. make it smarter.
         */
        let parameters = options.coin.parameters
        if (!parameters) {
            parameters = {
                N: 200,
                K: 9,
                personalization: 'ZcashPoW'
            }
        }

        let N = parameters.N || 200
        let K = parameters.K || 9
        let expectedLength = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_LENGTH || 2694
        let solutionSlice = EH_PARAMS_MAP[`${N}_${K}`].SOLUTION_SLICE || 0

        var decodedSoln = decodeCompactSolution(soln);
        if (decodedSoln.error) {
            return shareError([20, decodedSoln.error]);
        }
        if (soln.length !== expectedLength && decodedSoln.raw.length * 2 !== expectedLength) {
            return shareError([20, 'Error: Incorrect size of solution (' + soln.length + '), expected ' + expectedLength]);
        }

        if (!isHexString(extraNonce2)) {
            // console.log('invalid hex in extraNonce2');
            return shareError([20, 'invalid hex in extraNonce2']);
        }

        if (!job.registerSubmit(nonce, soln)) {
            return shareError([22, 'duplicate share']);
        }

        //console.log('processShare ck5')

        var extraNonce1Buffer = new Buffer(extraNonce1, 'hex');
        var extraNonce2Buffer = new Buffer(extraNonce2, 'hex');

        var headerBuffer = job.serializeHeader(nTime, nonce); // 144 bytes (doesn't contain soln)
        var headerSolnBuffer = Buffer.concat([headerBuffer, decodedSoln.raw]);
        var headerHash;

        //console.log('processShare ck6')

        headerHash = util.sha256d(headerSolnBuffer);

        //console.log('processShare ck7')

        var headerBigNum = bignum.fromBuffer(headerHash, {endian: 'little', size: 32});

        var blockHashInvalid;
        var blockHash;
        var blockHex;

        var shareDiff = diff1 / headerBigNum.toNumber() * shareMultiplier;
        var blockDiffAdjusted = job.difficulty * shareMultiplier;

        //console.log('processShare ck8')

        // check if valid solution
        var solutionForHash = decodedSoln.solution || new Buffer(soln.slice(solutionSlice), 'hex');
        if (hashDigest(headerBuffer, solutionForHash) !== true) {
            //console.log('invalid solution');
            return shareError([20, 'invalid solution']);
        }

        //check if block candidate
        if (headerBigNum.le(job.target)) {
            //console.log('begin serialization');
            blockHex = job.serializeBlock(headerBuffer, new Buffer(soln, 'hex')).toString('hex');
            blockHash = util.reverseBuffer(headerHash).toString('hex');
            //console.log('end serialization');
        } else {
            //console.log('low difficulty share');
            if (options.emitInvalidBlockHashes)
                blockHashInvalid = util.reverseBuffer(util.sha256d(headerSolnBuffer)).toString('hex');

            //Check if share didn't reached the miner's difficulty)
            if (shareDiff / difficulty < 0.99) {

                //Check if share matched a previous difficulty from before a vardiff retarget
                if (previousDifficulty && shareDiff >= previousDifficulty) {
                    difficulty = previousDifficulty;
                }
                else {
                    return shareError([23, 'low difficulty share of ' + shareDiff]);
                }

            }
        }

        /*
        console.log('validSoln: ' + hashDigest(headerBuffer, new Buffer(soln.slice(6), 'hex')));
        console.log('job: ' + jobId);
        console.log('ip: ' + ipAddress);
        console.log('port: ' + port);
        console.log('worker: ' + workerName);
        console.log('height: ' + job.rpcData.height);
        console.log('blockReward: ' + job.rpcData.reward);
        console.log('difficulty: ' + difficulty);
        console.log('shareDiff: ' + shareDiff.toFixed(8));
        console.log('blockDiff: ' + blockDiffAdjusted);
        console.log('blockDiffActual: ' + job.difficulty);
        console.log('blockHash: ' + blockHash);
        console.log('blockHashInvalid: ' + blockHashInvalid);
        */

        _this.emit('share', {
            job: jobId,
            ip: ipAddress,
            port: port,
            worker: workerName,
            height: job.rpcData.height,
            blockReward: job.rpcData.reward,
            difficulty: difficulty,
            prevHash: job.rpcData.previousblockhash,
            shareDiff: shareDiff.toFixed(8),
            blockDiff: blockDiffAdjusted,
            blockDiffActual: job.difficulty,
            blockHash: blockHash,
            blockHashInvalid: blockHashInvalid
        }, blockHex);

        return {result: true, error: null, blockHash: blockHash};
    };
};
JobManager.prototype.__proto__ = events.EventEmitter.prototype;
