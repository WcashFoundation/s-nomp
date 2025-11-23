// Monkey-patch stratum-pool to fetch a pool payout address per block from an external API.
// This runs before stratum-pool is required elsewhere in the codebase.

const fs = require('fs');
const path = require('path');
const Stratum = require('stratum-pool');
const OriginalJobManager = require('stratum-pool/lib/jobManager');

const ADDRESS_MAP_PATH = process.env.POOL_ADDRESS_MAP || path.join(process.cwd(), 'address_map.json');

function isLikelyAddress(addr) {
    if (!addr || typeof addr !== 'string') return false;
    const trimmed = addr.trim();
    if (trimmed.length < 20 || trimmed.length > 160) return false;
    return /^[a-zA-Z0-9]+$/.test(trimmed);
}

function fetchAddressForHeight(height) {
    try {
        const raw = fs.readFileSync(ADDRESS_MAP_PATH, 'utf8');
        const map = JSON.parse(raw);
        const addr = map[String(height)] || map[height] || map.default;
        return isLikelyAddress(addr) ? addr : null;
    } catch (e) {
        console.error(`[dynamicPoolAddress] Could not read ${ADDRESS_MAP_PATH}: ${e.message}`);
        return null;
    }
}

function PatchedJobManager(options) {
    const jm = new OriginalJobManager(options);
    const daemon = new Stratum.daemon.interface(options.daemon, function(sev, msg) {
        if (sev === 'error') {
            console.error(`[dynamicPoolAddress] daemon error: ${msg}`);
        }
    });

    const getBalanceForAddress = (method, params) => {
        return new Promise((resolve) => {
            daemon.cmd(method, params, function(results){
                if (!Array.isArray(results) || !results[0] || results[0].error) {
                    return resolve({ok:false});
                }
                return resolve({ok:true, value: results[0].response});
            });
        });
    };

    const ensureZeroBalance = async (address) => {
        // Try getreceivedbyaddress (standard bitcoin/zcash RPC)
        const recv = await getBalanceForAddress('getreceivedbyaddress', [address]);
        if (recv.ok && typeof recv.value !== 'undefined') {
            return Number(recv.value) === 0;
        }
        // Try getaddressbalance (addressindex-based)
        const bal = await getBalanceForAddress('getaddressbalance', [{addresses:[address]}]);
        if (bal.ok && bal.value && typeof bal.value.balance !== 'undefined') {
            return Number(bal.value.balance) === 0;
        }
        // Unknown balance -> treat as invalid to avoid using a non-fresh address
        console.error(`[dynamicPoolAddress] Could not verify zero balance for ${address}`);
        return false;
    };

    const usedAddresses = new Set();

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const updateAddressIfNeeded = async (rpcData) => {
        // Try until we get a fresh, unused address; retry every 5 seconds.
        for (;;) {
            const dynamicAddress = await fetchAddressForHeight(rpcData.height);
            if (!dynamicAddress) {
                console.error(`[dynamicPoolAddress] No valid address from API for height ${rpcData.height}, retrying in 5s.`);
                await delay(5000);
                continue;
            }
            if (usedAddresses.has(dynamicAddress)) {
                console.error(`[dynamicPoolAddress] Address ${dynamicAddress} already used, retrying in 5s.`);
                await delay(5000);
                continue;
            }
            const fresh = await ensureZeroBalance(dynamicAddress);
            if (!fresh) {
                console.error(`[dynamicPoolAddress] Address ${dynamicAddress} is not fresh (non-zero balance or unknown), retrying in 5s.`);
                await delay(5000);
                continue;
            }
            usedAddresses.add(dynamicAddress);
            options.address = dynamicAddress;
            return true;
        }
    };

    const originalProcessTemplate = jm.processTemplate;
    jm.processTemplate = async function patchedProcessTemplate(rpcData) {
        const ok = await updateAddressIfNeeded(rpcData);
        if (!ok) return false;
        return originalProcessTemplate.call(jm, rpcData);
    };

    const originalUpdateCurrentJob = jm.updateCurrentJob;
    jm.updateCurrentJob = async function patchedUpdateCurrentJob(rpcData) {
        const ok = await updateAddressIfNeeded(rpcData);
        if (!ok) return;
        return originalUpdateCurrentJob.call(jm, rpcData);
    };

    return jm;
}

// Replace the cached module export so stratum-pool consumers get the patched JobManager.
require.cache[require.resolve('stratum-pool/lib/jobManager')].exports = PatchedJobManager;
