var bignum = require('bignum');

var util = require('./util.js');

var diff1 = global.diff1;

function parseHeaderPrefix(prefixHex) {
    var buf = Buffer.from(prefixHex, 'hex');

    if (buf.length < 108) {
        throw new Error('Invalid NU5 header prefix length');
    }

    return {
        version: buf.slice(0, 4).toString('hex'),
        prevHash: buf.slice(4, 36).toString('hex'),
        merkleRoot: buf.slice(36, 68).toString('hex'),
        hashReserved: buf.slice(68, 100).toString('hex'),
        nTime: buf.slice(100, 104).toString('hex'),
        nBits: buf.slice(104, 108).toString('hex')
    };
}

/*
 * Minimal block template for Zebra NU5 mining. The node supplies the finalized
 * header prefix and transaction set; the pool just forwards work to miners.
 */
var Nu5BlockTemplate = module.exports = function Nu5BlockTemplate(jobId, rpcData, coin) {
    this.jobId = rpcData.job_id || jobId;

    // Normalize field names used elsewhere in the pool.
    rpcData.previousblockhash = rpcData.prevhash || rpcData.previousblockhash;
    rpcData.reward = rpcData.reward || rpcData.miner || 0;
    this.rpcData = rpcData;

    this.algoNK = coin.parameters && coin.parameters.N && coin.parameters.K ? coin.parameters.N + '_' + coin.parameters.K : undefined;
    this.persString = coin.parameters ? coin.parameters.personalization : undefined;

    this.headerPrefix = Buffer.from(rpcData.header_pre_nonce_solution, 'hex');
    this.headerParts = parseHeaderPrefix(rpcData.header_pre_nonce_solution);

    this.target = bignum(rpcData.target, 16);
    this.difficulty = parseFloat((diff1 / this.target.toNumber()).toFixed(9));

    this.txCount = 1 + (Array.isArray(rpcData.transactions) ? rpcData.transactions.length : 0);

    this.txs = [];
    if (rpcData.coinbasetxn) this.txs.push(rpcData.coinbasetxn);
    if (Array.isArray(rpcData.transactions)) {
        rpcData.transactions.forEach(function (tx) {
            this.txs.push(tx);
        }.bind(this));
    }

    var submits = [];

    this.registerSubmit = function (nonce, soln) {
        var submission = (nonce + soln).toLowerCase();
        if (submits.indexOf(submission) === -1) {
            submits.push(submission);
            return true;
        }
        return false;
    };

    this.serializeHeader = function (nonceHex) {
        return Buffer.concat([
            this.headerPrefix,
            Buffer.from(nonceHex, 'hex')
        ]);
    };

    this.serializeBlock = function (headerBuffer, solnBuffer) {
        var buffers = [
            headerBuffer,
            solnBuffer,
            util.varIntBuffer(this.txCount)
        ];

        this.txs.forEach(function (txHex) {
            buffers.push(Buffer.from(txHex, 'hex'));
        });

        return Buffer.concat(buffers);
    };

    // Used for mining.notify
    this.getJobParams = function () {
        if (!this.jobParams) {
            this.jobParams = [
                this.jobId,
                this.headerParts.version,
                this.headerParts.prevHash,
                this.headerParts.merkleRoot,
                this.headerParts.hashReserved,
                this.headerParts.nTime,
                this.headerParts.nBits,
                true,
                this.algoNK,
                this.persString
            ];
        }
        return this.jobParams;
    };
};
