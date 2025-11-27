### _**This is the current s-nomp variant validated for GPU mining against Zebra (z_getminingjob)**_

This fork is actively used as a pool for GPU miners: it accepts work from Zebra via `z_getminingjob`, hands it to miners, and successfully submits blocks. Verified on testnet and deployed to WCASH mainnet as part of a working pool stack.

If you want to experiment with mining, use [Zebra's guide to mining on testnet](https://github.com/ZcashFoundation/zebra/blob/main/book/src/user/mining-testnet-s-nomp.md).

# s-nomp: Some New Open Mining Portal

This is a Equihash mining pool based off Node Open Mining Portal.

# IMPORTANT

This fork does not pay any pool fees, because `s-nomp/node-stratum-pool` does not support Zcash NU5 transactions.
Instead, all fees are paid to the address in the node configuration.

## WCASH pool patches
- `node_modules/stratum-pool/lib/nu5BlockTemplate.js`: minimal NU5/Zebra template that treats node-supplied header/txs as opaque and builds blocks by appending nonce+solution.
- `node_modules/stratum-pool/lib/jobManager.js`: NU5 routing and job_id remap, relaxed NU5 checks, CompactSize Equihash decoding for NU5 and legacy, duplicate/length/hash validation.
- `node_modules/stratum-pool/lib/pool.js`: Zebra `useZGetMiningJob` init path (skip legacy probes, derive diff from `z_getminingjob`), subscription extranonce2 sizing, use `z_getminingjob` instead of GBT.
- `node_modules/stratum-pool/lib/stratum.js`: stratum subscribe returns `extranonce2_size` so miners build a correct 32-byte nonce.
- Copies of these patched files are stored under `wcash_pool_modules/stratum-pool/lib/` for reference.

### Troubleshooting builds
- The bundled `equihashverify` native module only builds cleanly against old Node/V8. If npm install fails on newer Node versions with V8/Nan errors, use Node 8.11 (nvm recommended):
  - `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && . "$NVM_DIR/nvm.sh"`
  - `nvm install 8.11.0 && nvm use 8.11.0 && npm install -g npm@6`
  - `rm -rf node_modules && npm install`

### Quick start on a fresh Ubuntu (WCASH/Zebra)
1. System deps:
   - `sudo apt update && sudo apt install -y build-essential python3 redis-server libsodium-dev libboost-all-dev curl git`
   - `sudo systemctl start redis-server && sudo systemctl enable redis-server`
2. Node 8.11 with nvm:
   - `curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && . "$HOME/.nvm/nvm.sh"`
   - `nvm install 8.11.0 && nvm use 8.11.0 && npm install -g npm@6`
3. Get and install s-nomp:
   - `git clone <your repo> ~/pool/s-nomp && cd ~/pool/s-nomp`
   - `rm -rf node_modules && npm install`
4. Apply patched stratum-pool files:
   - `cp wcash_pool_modules/stratum-pool/lib/{stratum.js,pool.js,jobManager.js,nu5BlockTemplate.js} node_modules/stratum-pool/lib/`
5. Configure:
   - `coins/wcash.json` with `useZGetMiningJob: true` and Equihash 200,9.
   - `pool_configs/wcash.json` with your Zebra RPC host/port (e.g. 127.0.0.1:17779), stratum port (e.g. 1235), and payout T-address.
6. Start the pool:
   - `nvm use 8.11.0`
   - `npm start`
   - Look for “Stratum Pool Server Started…” and “z_getminingjob init…” in logs.
7. Point miners: server `<ip>`, port `1235`, user `<taddr>.<worker>`, pass `x`.

#### Production Usage Notice
This is beta software. All of the following are things that can change and break an existing s-nomp setup: functionality of any feature, structure of configuration files and structure of redis data. If you use this software in production then *DO NOT* pull new code straight into production usage because it can and often will break your setup and require you to tweak things like config files or redis data. *Only tagged releases are considered stable.*

#### Paid Solution
Usage of this software requires abilities with sysadmin, database admin, coin daemons, and sometimes a bit of programming. Running a production pool can literally be more work than a full-time job. 

### Community / Support

Please join our Discord to follow development. Any support questions can be answered here quickly as well.

https://discord.gg/4mVaTsH

# Usage

#### Requirements
* Coin daemon(s) (find the coin's repo and build latest version from source)
* [Node.js](http://nodejs.org/) v8.11 ([follow these installation instructions](https://github.com/nodejs/node))
* [Redis](http://redis.io/) key-value store v2.6+ ([follow these instructions](http://redis.io/topics/quickstart))

##### Seriously
These are legitimate requirements. If you use old versions of Node.js or Redis that may come with your system package manager then you will have problems. Follow the linked instructions to get the last stable versions.

[**Redis security warning**](http://redis.io/topics/security): be sure firewall access to redis - an easy way is to
include `bind 127.0.0.1` in your `redis.conf` file. Also it's a good idea to learn about and understand software that
you are using - a good place to start with redis is [data persistence](http://redis.io/topics/persistence).

#### 0) Setting up coin daemon
Follow the build/install instructions for your coin daemon. Your coin.conf file should end up looking something like this:
```
daemon=1
rpcuser=zclassicrpc
rpcpassword=securepassword
rpcport=8232
```
For redundancy, its recommended to have at least two daemon instances running in case one drops out-of-sync or offline,
all instances will be polled for block/transaction updates and be used for submitting blocks. Creating a backup daemon
involves spawning a daemon using the `-datadir=/backup` command-line argument which creates a new daemon instance with
it's own config directory and coin.conf file. Learn about the daemon, how to use it and how it works if you want to be
a good pool operator. For starters be sure to read:
   * https://en.bitcoin.it/wiki/Running_bitcoind
   * https://en.bitcoin.it/wiki/Data_directory
   * https://en.bitcoin.it/wiki/Original_Bitcoin_client/API_Calls_list
   * https://en.bitcoin.it/wiki/Difficulty


#### 1) Downloading & Installing

Clone the repository and run `npm update` for all the dependencies to be installed:

```bash
sudo apt-get install build-essential libsodium-dev npm libboost-all-dev
sudo npm install n -g
sudo n stable
git clone https://github.com/s-nomp/s-nomp.git s-nomp
cd s-nomp
npm update
npm install
```

##### Pool config
Take a look at the example json file inside the `pool_configs` directory. Rename it to `zclassic.json` and change the
example fields to fit your setup.

```
Please Note that: 1 Difficulty is actually 8192, 0.125 Difficulty is actually 1024.

Whenever a miner submits a share, the pool counts the difficulty and keeps adding them as the shares. 

ie: Miner 1 mines at 0.1 difficulty and finds 10 shares, the pool sees it as 1 share. Miner 2 mines at 0.5 difficulty and finds 5 shares, the pool sees it as 2.5 shares. 
```


##### [Optional, recommended] Setting up blocknotify
1. In `config.json` set the port and password for `blockNotifyListener`
2. In your daemon conf file set the `blocknotify` command to use:
```
node [path to cli.js] [coin name in config] [block hash symbol]
```
Example: inside `zclassic.conf` add the line
```
blocknotify=node /home/user/s-nomp/scripts/cli.js blocknotify zclassic %s
```

Alternatively, you can use a more efficient block notify script written in pure C. Build and usage instructions
are commented in [scripts/blocknotify.c](scripts/blocknotify.c).


#### 3) Start the portal

```bash
npm start
```

###### Optional enhancements for your awesome new mining pool server setup:
* Use something like [forever](https://github.com/nodejitsu/forever) to keep the node script running
in case the master process crashes. 
* Use something like [redis-commander](https://github.com/joeferner/redis-commander) to have a nice GUI
for exploring your redis database.
* Use something like [logrotator](http://www.thegeekstuff.com/2010/07/logrotate-examples/) to rotate log 
output from s-nomp.
* Use [New Relic](http://newrelic.com/) to monitor your s-nomp instance and server performance.


#### Upgrading s-nomp
When updating s-nomp to the latest code its important to not only `git pull` the latest from this repo, but to also update
the `node-stratum-pool` and `node-multi-hashing` modules, and any config files that may have been changed.
* Inside your s-nomp directory (where the init.js script is) do `git pull` to get the latest s-nomp code.
* Remove the dependenices by deleting the `node_modules` directory with `rm -r node_modules`.
* Run `npm update` to force updating/reinstalling of the dependencies.
* Compare your `config.json` and `pool_configs/coin.json` configurations to the latest example ones in this repo or the ones in the setup instructions where each config field is explained. <b>You may need to modify or add any new changes.</b>


Credits
-------
### s-nomp
* [egyptianbman](https://github.com/egyptianbman)
* [nettts](https://github.com/nettts)
* [potato](https://github.com/zzzpotato)
* You belong here. Join us!

### z-nomp
* [Joshua Yabut / movrcx](https://github.com/joshuayabut)
* [Aayan L / anarch3](https://github.com/aayanl)
* [hellcatz](https://github.com/hellcatz)

### NOMP
* [Matthew Little / zone117x](https://github.com/zone117x) - developer of NOMP
* [Jerry Brady / mintyfresh68](https://github.com/bluecircle) - got coin-switching fully working and developed proxy-per-algo feature
* [Tony Dobbs](http://anthonydobbs.com) - designs for front-end and created the NOMP logo
* [LucasJones](//github.com/LucasJones) - got p2p block notify working and implemented additional hashing algos
* [vekexasia](//github.com/vekexasia) - co-developer & great tester
* [TheSeven](//github.com/TheSeven) - answering an absurd amount of my questions and being a very helpful gentleman
* [UdjinM6](//github.com/UdjinM6) - helped implement fee withdrawal in payment processing
* [Alex Petrov / sysmanalex](https://github.com/sysmanalex) - contributed the pure C block notify script
* [svirusxxx](//github.com/svirusxxx) - sponsored development of MPOS mode
* [icecube45](//github.com/icecube45) - helping out with the repo wiki
* [Fcases](//github.com/Fcases) - ordered me a pizza <3
* Those that contributed to [node-stratum-pool](//github.com/zone117x/node-stratum-pool#credits)

License
-------
Released under the MIT License. See LICENSE file.
