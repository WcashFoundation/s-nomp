/**
 * Quick NU5 debug helper:
 *   node libs/nu5Support.js pool_configs/zcash_zebra_nu5.json
 *
 * Reads daemon credentials from the given pool config and prints the result of
 * Zebra's z_getminingjob RPC.
 */
const fs = require('fs');
const http = require('http');

const configPath = process.argv[2] || 'pool_configs/zcash_zebra_nu5.json';

if (!fs.existsSync(configPath)) {
    console.error('Config file not found:', configPath);
    process.exit(1);
}

const poolConfig = JSON.parse(fs.readFileSync(configPath, {encoding: 'utf8'}));
const daemon = (poolConfig.daemons && poolConfig.daemons[0]) || {};

const payload = JSON.stringify({
    method: 'z_getminingjob',
    params: [],
    id: Date.now()
});

const options = {
    hostname: daemon.host || '127.0.0.1',
    port: daemon.port || 18232,
    method: 'POST',
    auth: `${daemon.user || ''}:${daemon.password || ''}`,
    headers: {
        'Content-Length': Buffer.byteLength(payload)
    }
};

const req = http.request(options, res => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            console.log(JSON.stringify(parsed.result || parsed, null, 2));
        } catch (err) {
            console.error('Failed to parse RPC response');
            console.error(err);
            console.error(data);
        }
    });
});

req.on('error', err => {
    console.error('RPC request failed:', err.message);
});

req.write(payload);
req.end();
