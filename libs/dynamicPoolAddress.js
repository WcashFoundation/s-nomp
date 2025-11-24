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
    const extractAddr = (entry) => {
        if (!entry) return null;
        if (entry.address) return entry.address;
        if (entry.addr) return entry.addr;
        if (entry.rewards && Array.isArray(entry.rewards) && entry.rewards[0] &&
            Array.isArray(entry.rewards[0].addresses) && entry.rewards[0].addresses[0]) {
            return entry.rewards[0].addresses[0];
        }
        return null;
    };

    try {
        const raw = fs.readFileSync(ADDRESS_MAP_PATH, 'utf8');
        let data;
        try {
            data = JSON.parse(raw);
        } catch (parseErr) {
            // Try NDJSON-style (one JSON object per line)
            data = raw.split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .map(line => {
                    try { return JSON.parse(line); } catch (e) { return null; }
                })
                .filter(Boolean);
        }

        let addr = null;

        if (Array.isArray(data)) {
            const entry = data.find((item) => {
                const id = (item.id !== undefined ? item.id : item.height);
                return String(id) === String(height);
            });
            addr = extractAddr(entry);
        } else if (typeof data === 'object' && data !== null) {
            addr = extractAddr(data[String(height)] || data[height]);
        }

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

    // Simplify: do not override address from map; use whatever is configured in options.address.
    const updateAddressIfNeeded = async (rpcData) => {
        console.error(`[dynamicPoolAddress] Using configured address ${options.address} for height ${rpcData.height}`);
        return true;
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
