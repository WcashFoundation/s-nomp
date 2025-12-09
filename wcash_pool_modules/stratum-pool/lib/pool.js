var events = require('events');
var async = require('async');
var bignum = require('bignum');
var crypto = require('crypto');

var varDiff = require('./varDiff.js');
var daemon = require('./daemon.js');
var peer = require('./peer.js');
var stratum = require('./stratum.js');
var jobManager = require('./jobManager.js');
var util = require('./util.js');

var diff1TargetHex = '07ffff0000000000000000000000000000000000000000000000000000000000';
var diff1BN = bignum(diff1TargetHex, 16);

function difficultyFromTargetHex(targetHex) {
    try {
        var target = bignum(targetHex, 16);
        if (target.cmpn(0) === 0) return 0;
        return diff1BN.div(target).toNumber();
    } catch (e) {
        return 0;
    }
}

/*process.on('uncaughtException', function(err) {
 console.log(err.stack);
 throw err;
 });*/

var pool = module.exports = function pool(options, authorizeFn) {

    this.options = options;

    var _this = this;
    var blockPollingIntervalId;


    var emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    var emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    var emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };
    var emitSpecialLog = function (text) {
        _this.emit('log', 'special', text);
    };


    if (!(options.coin.algorithm in algos)) {
        emitErrorLog('The ' + options.coin.algorithm + ' hashing algorithm is not supported.');
        throw new Error();
    }

    var blockSubmitConfig = Object.assign({
        enabled: false,
        minSpacingSeconds: 60,
        targetSpacingSeconds: 75,
        jitterSeconds: 10,
        minSpacingSeconds: 60,
        maxSpacingSeconds: 150,
        maxHoldSeconds: 150,
        speedUpStepSeconds: 1,
        slowDownStepSeconds: 1,
        difficultyLow: 80000,
        difficultyHigh: 120000,
        delayStepSeconds: 1,
        minDelayAdjustSeconds: -60,
        maxDelayAdjustSeconds: 300
    }, options.blockSubmission || {});
    var blockHoldEnabled = blockSubmitConfig.enabled === true;
    var blockSubmitQueue = [];
    var blockSubmissionActive = false;
    var blockDelayAdjustment = 0;
    var lastBlockSeenAtMs = blockHoldEnabled ? (Date.now() - (blockSubmitConfig.targetSpacingSeconds || 75) * 1000) : 0;
    var lastBlockSeenHeight = 0;
    var blockSubmitTimer = null;
    var lastResyncBroadcastAtMs = 0;
    var mockJobSliceSeconds = clamp((options.mockJobSliceSeconds || 10), 2, 30);
    var mockJobTtlMs = (options.mockJobTtlSeconds || 300) * 1000;
    var mockJobIds = new Map();
    var mockJobSeq = 0;
    var mockDispatchTimer = null;
    var pendingRealJob = null;
    var waitingForRealJob = false;
    var observedSolveSeconds = blockSubmitConfig.targetSpacingSeconds || 75;
    var realJobDispatchTimes = {};
    var lastBroadcastJobParams = null;


    this.start = function () {
        SetupVarDiff();
        SetupApi();
        SetupDaemonInterface(function () {
            DetectCoinData(function () {
                SetupRecipients();
                SetupJobManager();
                OnBlockchainSynced(function () {
                    GetFirstJob(function () {
                        SetupBlockPolling();
                        SetupPeer();
                        StartStratumServer(function () {
                            OutputPoolInfo();
                            _this.emit('started');
                        });
                    });
                });
            });
        });
    };


    function GetFirstJob(finishedCallback) {

        GetBlockTemplate(function (error, result) {
            if (error) {
                emitErrorLog('Error with getblocktemplate on creating first job, server cannot start');
                return;
            }

            var portWarnings = [];

            var networkDiffAdjusted = options.initStats.difficulty;
            if ((!networkDiffAdjusted || networkDiffAdjusted === 0) && _this.jobManager && _this.jobManager.currentJob) {
                networkDiffAdjusted = _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier;
                options.initStats.difficulty = networkDiffAdjusted;
            }

            Object.keys(options.ports).forEach(function (port) {
                var portDiff = options.ports[port].diff;
                if (networkDiffAdjusted < portDiff)
                    portWarnings.push('port ' + port + ' w/ diff ' + portDiff);
            });

            //Only let the first fork show synced status or the log wil look flooded with it
            if (portWarnings.length > 0 && (!process.env.forkId || process.env.forkId === '0')) {
                var warnMessage = 'Network diff of ' + networkDiffAdjusted + ' is lower than '
                    + portWarnings.join(' and ');
                emitWarningLog(warnMessage);
            }

            finishedCallback();

        });
    }


    function OutputPoolInfo() {

        var startMessage = 'Stratum Pool Server Started for ' + options.coin.name +
            ' [' + options.coin.symbol.toUpperCase() + '] {' + options.coin.algorithm + '}';
        if (process.env.forkId && process.env.forkId !== '0') {
            emitLog(startMessage);
            return;
        }
        var infoLines = [startMessage,
            'Network Connected:\t' + (options.testnet ? 'Testnet' : 'Mainnet'),
            'Detected Reward Type:\t' + options.coin.reward,
            'Current Block Height:\t' + _this.jobManager.currentJob.rpcData.height,
            'Current Block Diff:\t' + _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier,
            'Current Connect Peers:\t' + options.initStats.connections,
            'Network Difficulty:\t' + (options.initStats.difficulty || (_this.jobManager && _this.jobManager.currentJob ? _this.jobManager.currentJob.difficulty * algos[options.coin.algorithm].multiplier : 0)),
            'Network Hash Rate:\t' + util.getReadableHashRateString(options.initStats.networkHashRate),
            'Stratum Port(s):\t' + _this.options.initStats.stratumPorts.join(', '),
            'Pool Fee Percent:\t' + _this.options.feePercent + '%'
        ];

        if (typeof options.blockRefreshInterval === "number" && options.blockRefreshInterval > 0)
            infoLines.push('Block polling every:\t' + options.blockRefreshInterval + ' ms');

        emitSpecialLog(infoLines.join('\n\t\t\t\t\t\t'));
    }


    function OnBlockchainSynced(syncedCallback) {
        var generateProgress = function () {
            var cmd = options.coin.hasGetInfo ? 'getinfo' : 'getblockchaininfo';
            _this.daemon.cmd(cmd, [], function (results) {
                var blockCount = results.sort(function (a, b) {
                    return b.response.blocks - a.response.blocks;
                })[0].response.blocks;

                //get list of peers and their highest block height to compare to ours
                _this.daemon.cmd('getpeerinfo', [], function (results) {

                    var peers = results[0].response;
                    var totalBlocks = peers.sort(function (a, b) {
                        return b.startingheight - a.startingheight;
                    })[0].startingheight;

                    var percent = (blockCount / totalBlocks * 100).toFixed(2);
                    emitWarningLog('Downloaded ' + percent + '% of blockchain from ' + peers.length + ' peers');
                });

            });
        };

        if (options.coin.useZGetMiningJob) {
            var checkSyncedNu5 = function (displayNotSynced) {
                _this.daemon.cmd('z_getminingjob', [], function (results) {
                    var synced = results.every(function (r) {
                        return !r.error || r.error.code !== -10;
                    });
                    if (synced) {
                        syncedCallback();
                    }
                    else {
                        if (displayNotSynced) displayNotSynced();
                        setTimeout(checkSyncedNu5, 5000);

                        //Only let the first fork show synced status or the log wil look flooded with it
                        if (!process.env.forkId || process.env.forkId === '0')
                            generateProgress();
                    }

                });
            };
            checkSyncedNu5(function () {
                //Only let the first fork show synced status or the log wil look flooded with it
                if (!process.env.forkId || process.env.forkId === '0')
                    emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
            });
            return;
        }

        var callConfig = {
            "capabilities": [
                "coinbasetxn",
                "workid",
                "coinbase/append"
            ]
        };

        // Segwit support
        if (options.coin.supportsSegwit)
        {
            callConfig.rules = ["segwit"];
        }

        var checkSynced = function (displayNotSynced) {
            _this.daemon.cmd('getblocktemplate', callConfig, function (results) {
                var synced = results.every(function (r) {
                    return !r.error || r.error.code !== -10;
                });
                if (synced) {
                    syncedCallback();
                }
                else {
                    if (displayNotSynced) displayNotSynced();
                    setTimeout(checkSynced, 5000);

                    //Only let the first fork show synced status or the log wil look flooded with it
                    if (!process.env.forkId || process.env.forkId === '0')
                        generateProgress();
                }

            });
        };
        checkSynced(function () {
            //Only let the first fork show synced status or the log wil look flooded with it
            if (!process.env.forkId || process.env.forkId === '0')
                emitErrorLog('Daemon is still syncing with network (download blockchain) - server will be started once synced');
        });

    }


    function SetupApi() {
        if (typeof(options.api) !== 'object' || typeof(options.api.start) !== 'function') {
        } else {
            options.api.start(_this);
        }
    }


    function SetupPeer() {
        if (!options.p2p || !options.p2p.enabled)
            return;

        if (options.testnet && !options.coin.peerMagicTestnet) {
            emitErrorLog('p2p cannot be enabled in testnet without peerMagicTestnet set in coin configuration');
            return;
        }
        else if (!options.coin.peerMagic) {
            emitErrorLog('p2p cannot be enabled without peerMagic set in coin configuration');
            return;
        }

        _this.peer = new peer(options);
        _this.peer.on('connected', function () {
            emitLog('p2p connection successful');
        }).on('connectionRejected', function () {
            emitErrorLog('p2p connection failed - likely incorrect p2p magic value');
        }).on('disconnected', function () {
            emitWarningLog('p2p peer node disconnected - attempting reconnection...');
        }).on('connectionFailed', function (e) {
            emitErrorLog('p2p connection failed - likely incorrect host or port');
        }).on('socketError', function (e) {
            emitErrorLog('p2p had a socket error ' + JSON.stringify(e));
        }).on('error', function (msg) {
            emitWarningLog('p2p had an error ' + msg);
        }).on('blockFound', function (hash) {
            _this.processBlockNotify(hash, 'p2p');
        });
    }


    function SetupVarDiff() {
        _this.varDiff = {};
        Object.keys(options.ports).forEach(function (port) {
            if (options.ports[port].varDiff)
                _this.setVarDiff(port, options.ports[port].varDiff);
        });
    }


    /*
     Coin daemons either use submitblock or getblocktemplate for submitting new blocks
     */
    function SubmitBlock(blockHex, callback) {
        var rpcCommand, rpcArgs;
        if (options.hasSubmitMethod) {
            rpcCommand = 'submitblock';
            rpcArgs = [blockHex];
        }
        else {
            rpcCommand = 'getblocktemplate';
            rpcArgs = [{'mode': 'submit', 'data': blockHex}];
        }

        _this.daemon.cmd(rpcCommand,
            rpcArgs,
            function (results) {
                for (var i = 0; i < results.length; i++) {
                    var result = results[i];
                    if (result.error) {
                        emitErrorLog('rpc error with daemon instance ' +
                            result.instance.index + ' when submitting block with ' + rpcCommand + ' ' +
                            JSON.stringify(result.error)
                        );
                        return;
                    }
                    else if (result.response === 'rejected') {
                        emitErrorLog('Daemon instance ' + result.instance.index + ' rejected a supposedly valid block');
                        return;
                    }
                }
                emitLog('Submitted Block using ' + rpcCommand + ' successfully to daemon instance(s)');
                callback();
            }
        );
    }

    function clamp(val, min, max) {
        if (typeof min === 'number' && val < min) return min;
        if (typeof max === 'number' && val > max) return max;
        return val;
    }

    function clampDelayAdjustment(val) {
        var baseTarget = blockSubmitConfig.targetSpacingSeconds || 0;
        var minAdj = (blockSubmitConfig.minSpacingSeconds || 0) - baseTarget;
        var maxAdj = (blockSubmitConfig.maxSpacingSeconds || Number.POSITIVE_INFINITY) - baseTarget;
        if (typeof blockSubmitConfig.minDelayAdjustSeconds === 'number') {
            minAdj = Math.max(minAdj, blockSubmitConfig.minDelayAdjustSeconds);
        }
        if (typeof blockSubmitConfig.maxDelayAdjustSeconds === 'number') {
            maxAdj = Math.min(maxAdj, blockSubmitConfig.maxDelayAdjustSeconds);
        }
        return clamp(val, minAdj, maxAdj);
    }

    function registerMockJobId(jobId) {
        mockJobIds.set(jobId, Date.now() + mockJobTtlMs);
        // Keep map reasonably small
        if (mockJobIds.size > 200) {
            var now = Date.now();
            Array.from(mockJobIds.keys()).forEach(function (k) {
                if (mockJobIds.get(k) < now) mockJobIds.delete(k);
            });
        }
    }

    function isMockJobId(jobId) {
        if (!jobId) return false;
        var expires = mockJobIds.get(jobId);
        if (!expires) return false;
        if (expires < Date.now()) {
            mockJobIds.delete(jobId);
            return false;
        }
        return true;
    }

    function clearMockDispatchTimer() {
        if (mockDispatchTimer) clearTimeout(mockDispatchTimer);
        mockDispatchTimer = null;
    }

    function computeRealJobHoldSeconds() {
        if (!blockHoldEnabled) return 0;
        var baseTarget = blockSubmitConfig.targetSpacingSeconds || 0;
        var jitter = blockSubmitConfig.jitterSeconds || 0;
        var jitterOffset = jitter ? ((Math.random() * (jitter * 2)) - jitter) : 0;
        var enforcedMin = blockSubmitConfig.minSpacingSeconds || 0;
        var enforcedMax = blockSubmitConfig.maxSpacingSeconds || Number.POSITIVE_INFINITY;
        var targetSpacing = baseTarget + jitterOffset + blockDelayAdjustment;
        targetSpacing = clamp(targetSpacing, enforcedMin, enforcedMax);

        var estSolve = clamp(observedSolveSeconds || 0, 1, enforcedMax);
        var sinceLast = lastBlockSeenAtMs ? ((Date.now() - lastBlockSeenAtMs) / 1000) : 0;
        // Enforce a hard minimum spacing: if we’re inside the min window, hold at least the remainder.
        var minHoldSeconds = Math.max(0, enforcedMin - sinceLast);
        var holdSeconds = Math.max(minHoldSeconds, targetSpacing - estSolve - sinceLast);
        // Don’t allow release so late that spacing exceeds the max window.
        var maxHoldForSpacing = Math.max(0, enforcedMax - sinceLast);
        holdSeconds = Math.min(holdSeconds, maxHoldForSpacing);
        if (blockSubmitConfig.maxHoldSeconds) {
            holdSeconds = Math.min(holdSeconds, blockSubmitConfig.maxHoldSeconds);
        }
        return holdSeconds;
    }

    var currentHoldToken = 0;

    function broadcastRealJob(blockTemplate, forceClean) {
        if (!_this.stratumServer || !blockTemplate) return;
        clearMockDispatchTimer();
        waitingForRealJob = false;
        pendingRealJob = null;
        var job = blockTemplate.getJobParams();
        if (forceClean === true) job[7] = true;
        realJobDispatchTimes[blockTemplate.jobId] = Date.now();
        var dispatchKeys = Object.keys(realJobDispatchTimes);
        if (dispatchKeys.length > 50) {
            delete realJobDispatchTimes[dispatchKeys[0]];
        }
        lastBroadcastJobParams = job;
        _this.stratumServer.broadcastMiningJobs(job);
    }

    function broadcastMockJobSlice(remainingSeconds, holdToken) {
        if (!blockHoldEnabled) return;
        if (!_this.stratumServer) return;
        if (holdToken !== currentHoldToken) return;

        var template = pendingRealJob || (_this.jobManager && _this.jobManager.currentJob);
        if (!template || !template.getJobParams) return;

        var slice = Math.min(mockJobSliceSeconds, remainingSeconds);
        var leftover = Math.max(0, remainingSeconds - slice);

        var jobParams = template.getJobParams().slice();
        var mockId = 'mock-' + template.jobId + '-' + (++mockJobSeq);
        var prevBytes = (jobParams[2] && jobParams[2].length) ? Math.max(1, jobParams[2].length / 2) : 32;
        var rootBytes = (jobParams[3] && jobParams[3].length) ? Math.max(1, jobParams[3].length / 2) : 32;
        jobParams[0] = mockId;
        jobParams[2] = crypto.randomBytes(prevBytes).toString('hex');
        jobParams[3] = crypto.randomBytes(rootBytes).toString('hex');
        jobParams[7] = true;
        registerMockJobId(mockId);
        lastBroadcastJobParams = jobParams;
        _this.stratumServer.broadcastMiningJobs(jobParams);

        mockDispatchTimer = setTimeout(function () {
            if (holdToken !== currentHoldToken) return;
            if (leftover <= 0) {
                broadcastRealJob(pendingRealJob || template, true);
            } else {
                broadcastMockJobSlice(leftover, holdToken);
            }
        }, slice * 1000);
    }

    function scheduleRealJobDispatch(blockTemplate, forceClean) {
        pendingRealJob = blockTemplate;
        clearMockDispatchTimer();
        if (!blockHoldEnabled) {
            broadcastRealJob(blockTemplate, forceClean);
            return;
        }

        var holdSeconds = computeRealJobHoldSeconds();
        if (holdSeconds <= 0) {
            broadcastRealJob(blockTemplate, forceClean);
            return;
        }

        waitingForRealJob = true;
        currentHoldToken++;
        emitLog('Delaying real job for ' + holdSeconds.toFixed(1) + 's; issuing mock work slices of ' + mockJobSliceSeconds + 's');
        broadcastMockJobSlice(holdSeconds, currentHoldToken);
    }

    function recordNetworkBlockSeen(blockTemplate) {
        if (!blockHoldEnabled) return;
        // Use wall-clock arrival time to enforce the min spacing window; chain timestamps can lag/lead.
        lastBlockSeenAtMs = Date.now();
        if (blockTemplate && blockTemplate.rpcData && blockTemplate.rpcData.height) {
            lastBlockSeenHeight = blockTemplate.rpcData.height - 1;
        }
    }

    function recordAcceptedBlock(shareData) {
        if (!blockHoldEnabled) return;
        lastBlockSeenAtMs = Date.now();
        if (shareData && shareData.height) {
            lastBlockSeenHeight = shareData.height;
        }
    }

    function adjustDelayForDifficulty(blockDiff) {
        if (!blockHoldEnabled) return;
        var diffVal = parseFloat(blockDiff);
        if (isNaN(diffVal)) return;
        var slowStep = blockSubmitConfig.slowDownStepSeconds || blockSubmitConfig.delayStepSeconds || 1;
        var fastStep = blockSubmitConfig.speedUpStepSeconds || blockSubmitConfig.delayStepSeconds || 1;
        var updated = blockDelayAdjustment;
        if (blockSubmitConfig.difficultyHigh && diffVal > blockSubmitConfig.difficultyHigh) {
            updated = clampDelayAdjustment(blockDelayAdjustment + slowStep);
        }
        else if (blockSubmitConfig.difficultyLow && diffVal < blockSubmitConfig.difficultyLow) {
            updated = clampDelayAdjustment(blockDelayAdjustment - fastStep);
        }
        if (updated !== blockDelayAdjustment) {
            emitLog('Adjusted block submission delay to ' + updated + 's based on difficulty ' + diffVal);
        }
        blockDelayAdjustment = updated;
    }

    function shouldTreatCandidateAsStale(prevHash) {
        if (!blockHoldEnabled) return false;
        if (!prevHash) return false;
        if (!_this.jobManager || !_this.jobManager.currentJob || !_this.jobManager.currentJob.rpcData)
            return false;
        return _this.jobManager.currentJob.rpcData.previousblockhash !== prevHash;
    }

    function performBlockSubmit(ctx, done) {
        if (jobManagerLastSubmitBlockHex === ctx.blockHex) {
            emitWarningLog('Warning, ignored duplicate submit block ' + ctx.blockHex);
            ctx.isValidBlock = false;
            ctx.shareData.error = ctx.shareData.error || 'duplicate-submission';
            ctx.emitShare();
            if (done) done();
            return;
        }

        jobManagerLastSubmitBlockHex = ctx.blockHex;
        SubmitBlock(ctx.blockHex, function () {
            CheckBlockAccepted(ctx.shareData.blockHash, function (isAccepted, tx) {
                ctx.isValidBlock = isAccepted === true;
                if (ctx.isValidBlock === true) {
                    ctx.shareData.txHash = tx;
                    recordAcceptedBlock(ctx.shareData);
                } else {
                    ctx.shareData.error = tx;
                }
                ctx.emitShare();
                GetBlockTemplate(function (error, result, foundNewBlock) {
                    if (foundNewBlock) {
                        emitLog('Block notification via RPC after block submission');
                    }
                });
                if (done) done();
            });
        });
    }

    function processBlockSubmissionQueue() {
        if (!blockHoldEnabled) return;
        if (blockSubmissionActive || blockSubmitQueue.length === 0) return;

        var ctx = blockSubmitQueue.shift();
        adjustDelayForDifficulty(ctx.shareData.blockDiffActual);

        var now = Date.now();
        var sinceLast = lastBlockSeenAtMs ? ((now - lastBlockSeenAtMs) / 1000) : Number.POSITIVE_INFINITY;
        var baseTarget = blockSubmitConfig.targetSpacingSeconds || 75;
        var jitter = blockSubmitConfig.jitterSeconds || 0;
        var jitterOffset = jitter ? ((Math.random() * (jitter * 2)) - jitter) : 0;

        var enforcedMin = blockSubmitConfig.minSpacingSeconds || 0;
        var enforcedMax = blockSubmitConfig.maxSpacingSeconds || Number.POSITIVE_INFINITY;

        // Desired spacing clamped to the [min, max] window
        var targetSpacing = baseTarget + jitterOffset + blockDelayAdjustment;
        targetSpacing = clamp(targetSpacing, enforcedMin, enforcedMax);

        // Hold needed to reach desired spacing from last seen block
        var holdSeconds = Math.max(0, targetSpacing - sinceLast);

        // Ensure we never exceed the max spacing window
        var maxHoldForSpacing = Math.max(0, enforcedMax - sinceLast);
        holdSeconds = Math.min(holdSeconds, maxHoldForSpacing);

        // Additional safety cap on hold duration
        if (blockSubmitConfig.maxHoldSeconds) {
            holdSeconds = Math.min(holdSeconds, blockSubmitConfig.maxHoldSeconds);
        }

        if (holdSeconds > 0) {
            emitLog('Holding block submission for ' + holdSeconds.toFixed(1) +
                's (since last ' + sinceLast.toFixed(1) +
                's, target ' + targetSpacing.toFixed(1) +
                's, delayAdj ' + blockDelayAdjustment.toFixed(1) + 's)');
        }

        var submitCandidate = function () {
            blockSubmissionActive = true;

            if (shouldTreatCandidateAsStale(ctx.shareData.prevHash)) {
                emitWarningLog('Discarded stale block candidate after hold; chain advanced.');
                ctx.isValidBlock = false;
                ctx.shareData.error = ctx.shareData.error || 'stale-during-hold';
                blockSubmissionActive = false;
                ctx.emitShare();
                processBlockSubmissionQueue();
                return;
            }

            performBlockSubmit(ctx, function () {
                blockSubmissionActive = false;
                processBlockSubmissionQueue();
            });
        };

        if (holdSeconds > 0) {
            blockSubmissionActive = true;
            if (blockSubmitTimer) clearTimeout(blockSubmitTimer);
            blockSubmitTimer = setTimeout(submitCandidate, holdSeconds * 1000);
        } else {
            submitCandidate();
        }
    }

    function SetupRecipients() {
        var recipients = [];
        options.feePercent = 0;
        options.rewardRecipients = options.rewardRecipients || {};

        for (var r in options.rewardRecipients) {
            var percent = options.rewardRecipients[r];
            var rObj = {
                percent: percent,
                address: r
            };
                recipients.push(rObj);
                options.feePercent += percent;
        }

        if (recipients.length === 0) {
            emitErrorLog('No rewardRecipients have been setup which means no fees will be taken');
        }
        options.recipients = recipients;
    }

    var jobManagerLastSubmitBlockHex = false;

    function SetupJobManager() {
        options.daemon = _this.daemon
        _this.jobManager = new jobManager(options);

        _this.jobManager.on('newBlock', function (blockTemplate) {
            recordNetworkBlockSeen(blockTemplate);
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                scheduleRealJobDispatch(blockTemplate, true);
            } else {
                pendingRealJob = blockTemplate;
            }
        }).on('updatedBlock', function (blockTemplate) {
            //Check if stratumServer has been initialized yet
            if (_this.stratumServer) {
                if (waitingForRealJob && blockHoldEnabled) {
                    pendingRealJob = blockTemplate;
                } else {
                    var job = blockTemplate.getJobParams();
                    job[7] = false;
                    _this.stratumServer.broadcastMiningJobs(job);
                    lastBroadcastJobParams = job;
                }
            } else {
                pendingRealJob = blockTemplate;
            }
        }).on('share', function (shareData, blockHex) {
                var ctx = {
                    shareData: shareData,
                    blockHex: blockHex,
                    isValidShare: !shareData.error,
                    isValidBlock: !!blockHex
            };
            ctx.emitShare = function () {
                _this.emit('share', ctx.isValidShare, ctx.isValidBlock, ctx.shareData);
            };

            /*
             If we calculated that the block solution was found,
             before we emit the share, lets submit the block,
             then check if it was accepted using RPC getblock
             */
            if (!ctx.isValidBlock) {
                // If a miner is submitting against an unknown job, push a fresh job so it can resync quickly
                if (ctx.shareData && ctx.shareData.error === 'job not found' && _this.stratumServer && _this.jobManager && _this.jobManager.currentJob) {
                    // Aggressively resync on first job-not-found to quiet log spam; throttle lightly afterwards.
                    var nowMs = Date.now();
                    if (nowMs - lastResyncBroadcastAtMs > 500) {
                        var resyncJob = (lastBroadcastJobParams && lastBroadcastJobParams.slice()) || _this.jobManager.currentJob.getJobParams();
                        resyncJob[7] = true;
                        _this.stratumServer.broadcastMiningJobs(resyncJob);
                        lastBroadcastJobParams = resyncJob;
                        lastResyncBroadcastAtMs = nowMs;
                    }
                }
                ctx.emitShare();
            } else {
                adjustDelayForDifficulty(ctx.shareData.blockDiffActual);
                var dispatchAt = realJobDispatchTimes[ctx.shareData.job];
                if (dispatchAt) {
                    observedSolveSeconds = Math.max(1, (Date.now() - dispatchAt) / 1000);
                }
                performBlockSubmit(ctx);
            }
        }).on('log', function (severity, message) {
            _this.emit('log', severity, message);
        });
    }


    function SetupDaemonInterface(finishedCallback) {

        if (!Array.isArray(options.daemons) || options.daemons.length < 1) {
            emitErrorLog('No daemons have been configured - pool cannot start');
            return;
        }

        _this.daemon = new daemon.interface(options.daemons, function (severity, message) {
            _this.emit('log', severity, message);
        });

        _this.daemon.once('online', function () {
            finishedCallback();

        }).on('connectionFailed', function (error) {
            emitErrorLog('Failed to connect daemon(s): ' + JSON.stringify(error));

        }).on('error', function (message) {
            emitErrorLog(message);

        });

        _this.daemon.init();
    }


    function DetectCoinData(finishedCallback) {
        var skipValidateAddress = options.coin.useZGetMiningJob === true;
        var skipDifficulty = options.coin.useZGetMiningJob === true;

        if (options.coin.useZGetMiningJob) {
            // Zebra NU5 path: assume submitblock is supported and skip legacy probes that require params
            options.hasSubmitMethod = true;
            options.coin.reward = 'POW';
            options.poolAddressScript = Buffer.alloc(0);
            var daemonTargetsInit = options.daemons.map(function(d){ return d.host + ':' + d.port; }).join(', ');
            emitLog('z_getminingjob init against: ' + daemonTargetsInit);
            _this.daemon.cmd('z_getminingjob', [], function(res) {
                if (!res || res[0].error || !res[0].response || !res[0].response.target) {
                    emitErrorLog('Could not start pool, error with init RPC z_getminingjob on ' + daemonTargetsInit + ' - ' + JSON.stringify(res && res[0] && res[0].error));
                    return;
                }
                var target = bignum(res[0].response.target, 16);
                options.testnet = false;
                options.protocolVersion = 0;
                options.initStats = {
                    connections: 0,
                    difficulty: difficultyFromTargetHex(res[0].response.target) * algos[options.coin.algorithm].multiplier,
                    networkHashRate: 0
                };
                finishedCallback();
            });
            return;
        }

        var batchRpcCalls = [
            ['submitblock', []]
        ];

        if (!skipValidateAddress) {
            batchRpcCalls.push(['validateaddress', [options.address]]);
        }

        if (!skipDifficulty) {
            batchRpcCalls.push(['getdifficulty', []], ['getmininginfo', []]);
        }

        if (!skipDifficulty) {
            if (options.coin.hasGetInfo) {
                batchRpcCalls.push(['getinfo', []]);
            } else {
                batchRpcCalls.push(['getblockchaininfo', []], ['getnetworkinfo', []]);
            }
        }

        _this.daemon.batchCmd(batchRpcCalls, function (error, results) {
            if (error || !results) {
                emitErrorLog('Could not start pool, error with init batch RPC call: ' + JSON.stringify(error));
                return;
            }

            var rpcResults = {};

            for (var i = 0; i < results.length; i++) {
                var rpcCall = batchRpcCalls[i][0];
                var r = results[i];
                rpcResults[rpcCall] = r.result || r.error;

                if (rpcCall !== 'submitblock' && (r.error || !r.result)) {
                    if (skipValidateAddress && rpcCall === 'validateaddress') {
                        continue;
                    }
                    emitErrorLog('Could not start pool, error with init RPC ' + rpcCall + ' - ' + JSON.stringify(r.error));
                    return;
                }
            }

            if (!skipValidateAddress && !rpcResults.validateaddress.isvalid) {
                emitErrorLog('Daemon reports address is not valid');
                return;
            }

            if (skipDifficulty) {
                options.coin.reward = 'POW';
            } else if (isNaN(rpcResults.getdifficulty) && 'proof-of-stake' in rpcResults.getdifficulty)
                options.coin.reward = 'POS';
            else
                options.coin.reward = 'POW';


            /* POS coins must use the pubkey in coinbase transaction, and pubkey is
             only given if address is owned by wallet.*/
            if (!skipValidateAddress && options.coin.reward === 'POS' && typeof(rpcResults.validateaddress.pubkey) === 'undefined') {
                emitErrorLog('The address provided is not from the daemon wallet - this is required for POS coins.');
                return;
            }

            if (skipValidateAddress) {
                options.poolAddressScript = Buffer.alloc(0);
            } else {
                options.poolAddressScript = (function () {
                    return util.addressToScript(rpcResults.validateaddress.address);
                })();
            }

            var tempDifficulty;
            var setInitStats = function(tempDiffVal) {
                options.initStats = {
                    connections: skipDifficulty ? 0 : ((options.coin.hasGetInfo ? rpcResults.getinfo.connections : rpcResults.getnetworkinfo.connections) || 0),
                    difficulty: tempDiffVal * algos[options.coin.algorithm].multiplier,
                    networkHashRate: skipDifficulty ? 0 : rpcResults.getmininginfo.networkhashps
                };

                if (rpcResults.submitblock.message === 'Method not found') {
                    options.hasSubmitMethod = false;
                }
                else if (rpcResults.submitblock.code === -1) {
                    options.hasSubmitMethod = true;
                }
                else {
                    emitErrorLog('Could not detect block submission RPC method, ' + JSON.stringify(results));
                    return;
                }

                finishedCallback();
            };

            if (skipDifficulty) {
                var daemonTargets = options.daemons.map(function(d){ return d.host + ':' + d.port; }).join(', ');
                emitLog('z_getminingjob init against: ' + daemonTargets);
                _this.daemon.cmd('z_getminingjob', [], function(res) {
                    if (!res || res[0].error || !res[0].response || !res[0].response.target) {
                        emitErrorLog('Could not start pool, error with init RPC z_getminingjob on ' + daemonTargets + ' - ' + JSON.stringify(res && res[0] && res[0].error));
                        return;
                    }
                    var target = bignum(res[0].response.target, 16);
                    options.testnet = false;
                    options.protocolVersion = 0;
                    setInitStats(difficultyFromTargetHex(res[0].response.target));
                });
            } else {
                options.testnet = options.coin.hasGetInfo ? rpcResults.getinfo.testnet : rpcResults.getblockchaininfo.chain === "test";
                options.protocolVersion = options.coin.hasGetInfo ? rpcResults.getinfo.protocolversion : rpcResults.getnetworkinfo.protocolversion;

                tempDifficulty = options.coin.hasGetInfo ? rpcResults.getinfo.difficulty : rpcResults.getblockchaininfo.difficulty;
                if (typeof(tempDifficulty) == 'object') {
                    tempDifficulty = tempDifficulty['proof-of-work'];
                }
                setInitStats(tempDifficulty);
            }

        });
    }


    function StartStratumServer(finishedCallback) {
        _this.stratumServer = new stratum.Server(options, authorizeFn);

        _this.stratumServer.on('started', function () {
            options.initStats.stratumPorts = Object.keys(options.ports);
            scheduleRealJobDispatch(_this.jobManager.currentJob, true);
            finishedCallback();

        }).on('broadcastTimeout', function () {
            emitLog('No new blocks for ' + options.jobRebroadcastTimeout + ' seconds - updating transactions & rebroadcasting work');

            GetBlockTemplate( async function (error, rpcData, processedBlock) {
                if (error || processedBlock) return;
                await _this.jobManager.updateCurrentJob(rpcData);
            });

        }).on('client.connected', function (client) {
            if (typeof(_this.varDiff[client.socket.localPort]) !== 'undefined') {
                _this.varDiff[client.socket.localPort].manageClient(client);
            }

            client.on('difficultyChanged', function (diff) {
                _this.emit('difficultyUpdate', client.workerName, diff);

            }).on('subscription', function (params, resultCallback) {

                var extraNonce1 = _this.jobManager.extraNonceCounter.next();
                var nonceSize = (options.coin && options.coin.nonceSize) ? options.coin.nonceSize : 32;
                var extraNonce2Size = Math.max(0, nonceSize - _this.jobManager.extraNonceCounter.size);

                resultCallback(null,
                    extraNonce1,
                    extraNonce2Size
                );

                if (typeof(options.ports[client.socket.localPort]) !== 'undefined' && options.ports[client.socket.localPort].diff) {
                    this.sendDifficulty(options.ports[client.socket.localPort].diff);
                } else {
                    this.sendDifficulty(8);
                }
                var job = lastBroadcastJobParams || (_this.jobManager && _this.jobManager.currentJob && _this.jobManager.currentJob.getJobParams());
                if (job) {
                    this.sendMiningJob(job);
                }

            }).on('submit', function (params, resultCallback) {
                if (isMockJobId(params.jobId)) {
                    resultCallback(null, true);
                    return;
                }
                var result = _this.jobManager.processShare(
                    params.jobId,
                    client.previousDifficulty,
                    client.difficulty,
                    client.extraNonce1,
                    params.extraNonce2,
                    params.nTime,
                    params.nonce,
                    client.remoteAddress,
                    client.socket.localPort,
                    params.name,
                    params.soln
                );

                resultCallback(result.error, result.result ? true : null);

            }).on('malformedMessage', function (message) {
                emitWarningLog('Malformed message from ' + client.getLabel() + ': ' + message);

            }).on('socketError', function (err) {
                emitWarningLog('Socket error from ' + client.getLabel() + ': ' + JSON.stringify(err));

            }).on('socketTimeout', function (reason) {
                emitWarningLog('Connected timed out for ' + client.getLabel() + ': ' + reason)

            }).on('socketDisconnect', function () {
                //emitLog('Socket disconnected from ' + client.getLabel());

            }).on('kickedBannedIP', function (remainingBanTime) {
                emitLog('Rejected incoming connection from ' + client.remoteAddress + ' banned for ' + remainingBanTime + ' more seconds');

            }).on('forgaveBannedIP', function () {
                emitLog('Forgave banned IP ' + client.remoteAddress);

            }).on('unknownStratumMethod', function (fullMessage) {
                emitLog('Unknown stratum method from ' + client.getLabel() + ': ' + fullMessage.method);

            }).on('socketFlooded', function () {
                emitWarningLog('Detected socket flooding from ' + client.getLabel());

            }).on('tcpProxyError', function (data) {
                emitErrorLog('Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ' + data);

            }).on('bootedBannedWorker', function () {
                emitWarningLog('Booted worker ' + client.getLabel() + ' who was connected from an IP address that was just banned');

            }).on('triggerBan', function (reason) {
                emitWarningLog('Banned triggered for ' + client.getLabel() + ': ' + reason);
                _this.emit('banIP', client.remoteAddress, client.workerName);
            });
        });
    }


    function SetupBlockPolling() {
        if (typeof options.blockRefreshInterval !== "number" || options.blockRefreshInterval <= 0) {
            emitLog('Block template polling has been disabled');
            return;
        }

        var pollingInterval = options.blockRefreshInterval;

        blockPollingIntervalId = setInterval(function () {
            GetBlockTemplate(function (error, result, foundNewBlock) {
                if (foundNewBlock)
                    emitLog('Block notification via RPC polling');
            });
        }, pollingInterval);
    }


    function GetBlockTemplate(callback) {
        if (options.coin.useZGetMiningJob) {
            return GetZebraMiningJob(callback);
        }
        function  getNextBlockHeight() {
            // If the current job has a height value (chainTip + 1 from last GBT RPC call) use it, as it's less expensive than doing another RPC call in a function called by each pool fork when polling.
            // On the first call after a new block has arrived this data will be outdated, but this time window is very small due to RPC polling and jobRebroadcastTimeout, and only relevant on a halving block boundry condition.
            if (typeof(_this.jobManager) !== 'undefined' && typeof(_this.jobManager.currentJob) !== 'undefined' && typeof(_this.jobManager.currentJob.rpcData) !== 'undefined' && typeof(_this.jobManager.currentJob.rpcData.height) !== 'undefined') {
                getBlockSubsidyandTemplate(_this.jobManager.currentJob.rpcData.height);
            // Otherwise do a 'getblockcount' RPC call returning chainTip + 1, this would be the case on GetFirstJob().
            } else {
                _this.daemon.cmd(
                    'getblockcount',
                    [],
                    result => result.error ? callback(result.error) : getBlockSubsidyandTemplate(result[0].response + 1)
                )
            }
        }

        function getBlockSubsidyandTemplate(blockheight) {
            _this.daemon.cmd(
                'getblocksubsidy',
                [blockheight],
                result => result.error ? callback(result.error) : getBlockTemplate(result[0].response)
            )
        }

        function getBlockTemplate(subsidy) {
            var callConfig = {
                "capabilities": [
                    "coinbasetxn",
                    "workid",
                    "coinbase/append"
                ]
            };

            // Segwit support
            if (options.coin.supportsSegwit)
            {
                callConfig.rules = ["segwit"];
            }

            _this.daemon.cmd('getblocktemplate',
            [callConfig],
            async function (result) {
                    if (result.error) {
                        emitErrorLog('getblocktemplate call failed for daemon instance ' +
                            result.instance.index + ' with error ' + JSON.stringify(result.error));
                        callback(result.error);
                    } else {
                        result.response.miner = subsidy.miner;

                        if (options.coin.vFundingStreams) {
                            //Zcash uses fundingstreams instead of founders reward
                            result.response.fundingstreams = subsidy.fundingstreams
                        } else if (!result.response.founders)
                        {
                            result.response.founders = (subsidy.founders || subsidy.community || (subsidy['founders-chris'] + subsidy['founders-jimmy'] + subsidy['founders-scott'] + subsidy['founders-shelby'] + subsidy['founders-loki'] ));
                        } else {
                            // founders already set in block template
                            // console.log(result.response.founders);
                        }

                        //SnowGem treasury reward
                        if(subsidy.treasury)
                        {
                            result.response.treasury = subsidy.treasury
                        }

                        // I hate to do this but vision coin doesn't send the
                        // correct response for getblocksubsidy so this allows
                        // us to override.
                        if (options.coin.rewardMinersPercent) {
                            result.response.miner = options.coin.blockReward * options.coin.rewardMinersPercent
                        }

                        if (options.coin.rewardFoundersPercent) {
                            result.response.founders = options.coin.blockReward * options.coin.rewardFoundersPercent
                        }

                        result.response.securenodes = (subsidy.securenodes || 0);
                        result.response.supernodes = (subsidy.supernodes || 0);

                        // SafeCash / Genx
                        if (!result.response.masternode_payments_started) {
                            // Before masternodes
                            result.response.infrastructure = (subsidy.infrastructure || 0);
                            result.response.giveaways = (subsidy.giveaways || 0);
                            result.response.chris = (subsidy['founders-chris'] || 0);
                            result.response.jimmy = (subsidy['founders-jimmy'] || 0);
                            result.response.scott = (subsidy['founders-scott'] || 0);
                            result.response.shelby = (subsidy['founders-shelby'] || 0);
                            result.response.loki = (subsidy['founders-loki'] || 0);
                        } else {
                            // Masternodes active
                            result.response.infrastructure = (subsidy.infrastructure || 0);
                            result.response.giveaways = (subsidy.giveaways || 0);
                            result.response.masternodestotal = (subsidy.masternodestotal || 0);
                            result.response.governancetotal = (subsidy.governancetotal || 0);
                            result.response.founderstotal = (subsidy.founderstotal || 0);
                            result.response.founderamount = (subsidy.founderamount || 0);
                        }

                        var processedNewBlock =  await _this.jobManager.processTemplate(result.response);
                        callback(null, result.response, processedNewBlock);
                        callback = () => {
                        }
                    }
                }, true
            );
        }

        getNextBlockHeight();
    }

    function GetZebraMiningJob(callback) {
        _this.daemon.cmd(
            'z_getminingjob',
            [],
            async function (result) {
                try {
                    if (result.error) {
                        var instanceLabel = (result.instance && result.instance.host) ?
                            (result.instance.host + ':' + result.instance.port) :
                            ('instance ' + result.instance.index);
                        emitErrorLog('z_getminingjob call failed for daemon ' +
                            instanceLabel + ' with error ' + JSON.stringify(result.error));
                        callback(result.error);
                    } else {
                        var processedNewBlock = await _this.jobManager.processTemplate(result.response);
                        callback(null, result.response, processedNewBlock);
                        callback = () => {
                        }
                    }
                } catch (e) {
                    emitErrorLog('z_getminingjob processing threw: ' + e.stack);
                    callback(e);
                }
            }, true
        );
    }


    function CheckBlockAccepted(blockHash, callback) {
        //setTimeout(function(){
        _this.daemon.cmd('getblock',
            [blockHash],
            function (results) {
                var validResults = results.filter(function (result) {
                    return result.response && (result.response.hash === blockHash)
                });
                // do we have any results?
                if (validResults.length >= 1) {
                    // check for invalid blocks with negative confirmations
                    if (validResults[0].response.confirmations >= 0) {
                        // accepted valid block!
                        callback(true, validResults[0].response.tx[0]);
                    } else {
                        // reject invalid block, due to confirmations
                        callback(false, {"confirmations": validResults[0].response.confirmations});
                    }
                    return;
                }
                // invalid block, rejected
                callback(false, {"unknown": "check coin daemon logs"});
            }
        );
    }


    /**
     * This method is being called from the blockNotify so that when a new block is discovered by the daemon
     * We can inform our miners about the newly found block
     **/
    this.processBlockNotify = function (blockHash, sourceTrigger) {
        emitLog('Block notification via ' + sourceTrigger);
        if (typeof(_this.jobManager) !== 'undefined' && typeof(_this.jobManager.currentJob) !== 'undefined' && typeof(_this.jobManager.currentJob.rpcData.previousblockhash) !== 'undefined' && blockHash !== _this.jobManager.currentJob.rpcData.previousblockhash) {
            GetBlockTemplate(function (error, result) {
                if (error)
                    emitErrorLog('Block notify error getting block template for ' + options.coin.name);
            })
        }
    };


    this.relinquishMiners = function (filterFn, resultCback) {
        var origStratumClients = this.stratumServer.getStratumClients();

        var stratumClients = [];
        Object.keys(origStratumClients).forEach(function (subId) {
            stratumClients.push({subId: subId, client: origStratumClients[subId]});
        });
        async.filter(
            stratumClients,
            filterFn,
            function (clientsToRelinquish) {
                clientsToRelinquish.forEach(function (cObj) {
                    cObj.client.removeAllListeners();
                    _this.stratumServer.removeStratumClientBySubId(cObj.subId);
                });

                process.nextTick(function () {
                    resultCback(
                        clientsToRelinquish.map(
                            function (item) {
                                return item.client;
                            }
                        )
                    );
                });
            }
        )
    };


    this.attachMiners = function (miners) {
        miners.forEach(function (clientObj) {
            _this.stratumServer.manuallyAddStratumClient(clientObj);
        });
        _this.stratumServer.broadcastMiningJobs(_this.jobManager.currentJob.getJobParams());

    };


    this.getStratumServer = function () {
        return _this.stratumServer;
    };


    this.setVarDiff = function (port, varDiffConfig) {
        if (typeof(_this.varDiff[port]) !== 'undefined') {
            _this.varDiff[port].removeAllListeners();
        }
        _this.varDiff[port] = new varDiff(port, varDiffConfig);
        _this.varDiff[port].on('newDifficulty', function (client, newDiff) {

            /* We request to set the newDiff @ the next difficulty retarget
             (which should happen when a new job comes in - AKA BLOCK) */
            client.enqueueNextDifficulty(newDiff);

            /*if (options.varDiff.mode === 'fast'){
             //Send new difficulty, then force miner to use new diff by resending the
             //current job parameters but with the "clean jobs" flag set to false
             //so the miner doesn't restart work and submit duplicate shares
             client.sendDifficulty(newDiff);
             var job = _this.jobManager.currentJob.getJobParams();
             job[7] = false;
             client.sendMiningJob(job);
             }*/

        });
    };

};
pool.prototype.__proto__ = events.EventEmitter.prototype;
