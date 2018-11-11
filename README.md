# augur-crowdsourcer-basic-executor

[![Build Status](https://travis-ci.com/arbsfo/augur-crowdsourcer-basic-executor.svg?token=LoUpfgJgxrz8v6fjkgqm&branch=master)](https://travis-ci.com/arbsfo/augur-crowdsourcer-basic-executor)

Docker image: https://hub.docker.com/r/augurdisputecrowdsourcer/basic-executor/

This software monitors contracts of https://github.com/burdakovd/augur-dispute-crowdsourcer and whenever it sees an opportunity, it executes it, provided that the fees collected will be higher than gas costs. It also collects fees afterwards.

# ways to run

 - `docker run augurdisputecrowdsourcer/basic-executor` - the simplest way. Will download image from Docker hub and run it.
 - `yarn dev` - run during development, will run via `babel-node`, requires local repository checkout
 - `yarn start` - run built version, requires local repository checkout and preliminary `yarn build`
 
# supplying config

Example config is provided as `config/config.example.json`, should be modified accordingly, and then supplied with `--config` option.

When running in Docker, one would also need to mount external directory to let Docker see your config, e.g. `docker run -v $(pwd)/my_config_dir:/src/config augurdisputecrowdsourcer/basic-executor`. Since by default Docker reads from `/src/config/config.json`, you don't need to supply `--config` option.

# config options

```
{
  // self-explanatory
  "ethereumNode": "https://gethnode.com/http",
  // This should be your personal account and you do not need to supply private key for it here
  "feeRecipient": "0x2404a39e447d0c8b417049fc42b468a26990b4cc",
  // account that will actually run disputes, you need to supply private key in next param
  // this account should not be used anywhere else. It will also need some ETH for gas.
  "executionAccount": "...",
  "executionPrivateKey":
    "b0bbead64973f7979adc40013411c3ab45727f88049ca9c79db9d35847ae33a1",
  // Account that will collect fees for you, you need to supply private key in next param
  // this account should not be used anywhere else. It will need some small amount of ETH for gas.
  "feeCollectionTriggerAccount": "...",
  "feeCollectionTriggerPrivateKey":
    "da3b34aa4e9697e247e7b79de8323fd6d6f5883c4cae92436d2fca22de23634c",
  // min/max gas prices. If calculated gas below min, transaction is skipped. If it is above max, it is capped at max.
  "minGasPrice": 1000000000,
  "maxGasPrice": 100000000000,
  // how much of our fees we want to spend on gas. The higher the value, the higher chance of winning, but
  // more money is wasted and we end up with less on hand
  "aggressiveness": 0.3
}
```

# commands

Run `docker run augurdisputecrowdsourcer/basic-executor` without options to see commands.

 - `run`: run it forever, most of the time you need this command
 - `resetState`: reset internal state, forget all markets and pools. Is useful if you changed config in some incompatible way (i.e. switched between mainnet and testnet)
 - `sync`: do not run any transactions, just sync with blockchain once. Useful for verifying if your set up can discover markets and pools, and if there are any interesting pools created.
