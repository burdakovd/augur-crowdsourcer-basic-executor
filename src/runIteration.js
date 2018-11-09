// @flow

import type { Config } from "./config";
import type { State, Address } from "./state";
import { addMarket } from "./reducers";
import AugurCoreABI from "augur-core/output/contracts/abi.json";
import CrowdsourcerFactory from "augur-dispute-crowdsourcer/build/contracts/CrowdsourcerFactory.json";
import Crowdsourcer from "augur-dispute-crowdsourcer/build/contracts/Crowdsourcer.json";
import Disputer from "augur-dispute-crowdsourcer/build/contracts/Disputer.json";
import { Set as ImmSet, Range as ImmRange, List as ImmList } from "immutable";
import sleep from "sleep-promise";
import Augur from "augur.js";
import Web3 from "web3";
import nullthrows from "nullthrows";
import { stringifyCrowdsourcerSignature } from "./state";

async function getUniverseAddress(augur: Augur): Promise<Address> {
  const syncData = await new Promise((resolve, reject) =>
    augur.augurNode.getSyncData(function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    })
  );

  return syncData.addresses.Universe;
}

async function findMarkets(
  augur: Augur,
  web3: Web3,
  state: State
): Promise<State> {
  const universeAddress = await getUniverseAddress(augur);

  const addresses: ImmSet<string> = await Promise.all(
    ["CROWDSOURCING_DISPUTE", "AWAITING_NEXT_WINDOW"].map(
      state =>
        new Promise((resolve, reject) =>
          augur.markets.getMarkets(
            {
              universe: universeAddress,
              reportingState: state
            },
            function(error, result) {
              if (error) {
                reject(error);
              } else {
                resolve(result);
              }
            }
          )
        )
    )
  ).then(a =>
    ImmList(a)
      .flatMap(x => x)
      .toSet()
  );

  const markets = await Promise.all(
    addresses
      .toArray()
      .filter(address => !state.markets.has(address))
      .map(async address => {
        const numOutcomes = await new web3.eth.Contract(
          AugurCoreABI.Market,
          address
        ).methods
          .getNumberOfOutcomes()
          .call()
          .then(Number.parseInt);

        const numTicks = await new web3.eth.Contract(
          AugurCoreABI.Market,
          address
        ).methods
          .getNumTicks()
          .call()
          .then(Number.parseInt);

        if (numTicks !== 10000) {
          return null;
        }
        return {
          address,
          numOutcomes
        };
      })
  ).then(a => a.filter(x => x != null).map(x => nullthrows(x)));

  for (const market of markets) {
    console.log(`Discovered new market: ${market.address}`);
    state = addMarket(state, market.address, {
      numOutcomes: market.numOutcomes
    });
  }

  return state;
}

async function markMarketIsOver(web3: Web3, state: State): Promise<State> {
  await Promise.all(
    state.markets
      .map(async (data, address) => {
        if (data.isOver) {
          return;
        }

        const feeWindowAddress = await new web3.eth.Contract(
          AugurCoreABI.Market,
          address
        ).methods
          .getFeeWindow()
          .call();

        if (web3.utils.toBN(feeWindowAddress).eq(web3.utils.toBN(0))) {
          return;
        }

        const feeWindowIsOver = await new web3.eth.Contract(
          AugurCoreABI.FeeWindow,
          feeWindowAddress
        ).methods
          .isOver()
          .call();

        if (feeWindowIsOver) {
          state = {
            ...state,
            markets: state.markets.set(address, { ...data, isOver: true })
          };
        }
      })
      .valueSeq()
      .toArray()
  );

  return state;
}

async function getCurrentFeeWindowID(
  augur: Augur,
  web3: Web3
): Promise<number> {
  const universeAddress = await getUniverseAddress(augur);
  const disputeRoundDurationSeconds = await new web3.eth.Contract(
    AugurCoreABI.Universe,
    universeAddress
  ).methods
    .getDisputeRoundDurationInSeconds()
    .call()
    .then(Number.parseInt);

  const now = Date.now() / 1000;
  return Math.floor(now / disputeRoundDurationSeconds);
}

async function discoverCrowdsourcers(
  augur: Augur,
  web3: Web3,
  state: State
): Promise<State> {
  const currentFeeWindowID = await getCurrentFeeWindowID(augur, web3);
  console.log(`We are in fee window ${currentFeeWindowID}`);

  await Promise.all(
    [currentFeeWindowID, currentFeeWindowID + 1].map(
      async targetFeeWindowID =>
        await Promise.all(
          state.markets
            .map(async (marketData, address) => {
              if (marketData.isOver) {
                return;
              }

              await Promise.all(
                ImmList(ImmRange(0, marketData.numOutcomes))
                  .push(null)
                  .map(async outcomeIndex => {
                    const invalid = outcomeIndex === null;
                    const numTicks = 10000;
                    const numerators = ImmRange(0, marketData.numOutcomes)
                      .map(
                        i =>
                          invalid
                            ? Math.floor(numTicks / marketData.numOutcomes)
                            : i === outcomeIndex
                              ? numTicks
                              : 0
                      )
                      .toList();

                    const key = stringifyCrowdsourcerSignature(
                      targetFeeWindowID,
                      invalid,
                      numerators
                    );

                    if (marketData.crowdsourcers.has(key)) {
                      return;
                    }

                    const poolAddress = await new web3.eth.Contract(
                      CrowdsourcerFactory.abi,
                      CrowdsourcerFactory.networks["1"].address
                    ).methods
                      .maybeGetCrowdsourcer(
                        address,
                        web3.utils.toHex(targetFeeWindowID),
                        numerators.map(n => web3.utils.toHex(n)).toArray(),
                        invalid
                      )
                      .call();

                    if (web3.utils.toBN(poolAddress).eq(web3.utils.toBN(0))) {
                      return;
                    }

                    const crowdsourcer = new web3.eth.Contract(
                      Crowdsourcer.abi,
                      poolAddress
                    );

                    const isInitialized = await crowdsourcer.methods
                      .isInitialized()
                      .call();

                    if (!isInitialized()) {
                      return;
                    }

                    const disputer = await crowdsourcer.methods
                      .getDisputer()
                      .call();

                    console.log(
                      `Discovered new pool ${poolAddress} for market ${address}, '${
                        invalid ? "invalid" : "valid"
                      }', payout numerators ${JSON.stringify(
                        numerators.toArray()
                      )}, fee window ${targetFeeWindowID}`
                    );

                    state = {
                      ...state,
                      markets: state.markets.update(address, marketData => ({
                        ...marketData,
                        crowdsourcers: marketData.crowdsourcers.set(key, {
                          feeWindowID: targetFeeWindowID,
                          invalid,
                          numerators,
                          address: poolAddress,
                          disputer: disputer
                        })
                      }))
                    };
                  })
                  .toArray()
              );
            })
            .valueSeq()
            .toArray()
        )
    )
  );

  return state;
}

async function collectFees(
  augur: Augur,
  web3: Web3,
  config: Config,
  state: State
): Promise<State> {
  const currentFeeWindowID = await getCurrentFeeWindowID(augur, web3);

  await Promise.all(
    state.markets
      .map(async (marketData, marketAddress) => {
        const crowdsourcers = marketData.crowdsourcers;

        await Promise.all(
          crowdsourcers
            .map(async (crowdsourcerData, crowdsourcerKey) => {
              if (crowdsourcerData.feeWindowID > currentFeeWindowID) {
                return;
              }

              const crowdsourcer = new web3.eth.Contract(
                Crowdsourcer.abi,
                crowdsourcerData.address
              );

              const disputer = new web3.eth.Contract(
                Crowdsourcer.abi,
                crowdsourcerData.disputer
              );

              const feesCollected = await crowdsourcer.methods
                .m_feesCollected()
                .call();

              if (feesCollected) {
                return;
              }

              const feeRecipient = await disputer.methods
                .m_feeReceiver()
                .call();

              if (feeRecipient !== config.feeRecipient) {
                return;
              }

              console.log(
                `Sending transaction to collect fees from ${
                  crowdsourcerData.address
                } (market ${marketAddress})`
              );

              await crowdsourcer.methods.withdrawFees().send();

              // sleep some time to avoid race conditions that will cause to
              // send transaction twice on certain pools
              await sleep(60000);
            })
            .valueSeq()
            .toArray()
        );
      })
      .valueSeq()
      .toArray()
  );

  return state;
}

async function cleanupOldCrowdsourcers(
  augur: Augur,
  web3: Web3,
  state: State
): Promise<State> {
  const currentFeeWindowID = await getCurrentFeeWindowID(augur, web3);

  state.markets.forEach(async (marketData, marketAddress) => {
    marketData.crowdsourcers.forEach(
      async (crowdsourcerData, crowdsourcerKey) => {
        if (crowdsourcerData.feeWindowID >= currentFeeWindowID - 3) {
          return;
        }

        // if it is more than three windows old, clean it up
        console.log(
          `Cleaning up old crowdsourcer ${crowdsourcerKey} (${
            crowdsourcerData.address
          }) for market ${marketAddress}`
        );
        state = {
          ...state,
          markets: state.markets.update(marketAddress, marketData => ({
            ...marketData,
            crowdsourcers: marketData.crowdsourcers.delete(crowdsourcerKey)
          }))
        };
      }
    );
  });

  return state;
}

async function cleanupOldMarkets(state: State): Promise<State> {
  state.markets.forEach(async (marketData, marketAddress) => {
    if (!marketData.isOver) {
      return;
    }

    if (marketData.crowdsourcers.size > 0) {
      return;
    }

    console.log(`Cleaning up old market ${marketAddress}`);

    state = {
      ...state,
      markets: state.markets.delete(marketAddress)
    };
  });

  return state;
}

async function runIteration(
  augur: Augur,
  web3: Web3,
  config: Config,
  state: State,
  persist: State => Promise<void>
): Promise<State> {
  state = await findMarkets(augur, web3, state);
  await persist(state);
  state = await markMarketIsOver(web3, state);
  await persist(state);
  state = await discoverCrowdsourcers(augur, web3, state);
  await persist(state);
  state = await collectFees(augur, web3, config, state);
  await persist(state);
  state = await cleanupOldCrowdsourcers(augur, web3, state);
  await persist(state);
  state = await cleanupOldMarkets(state);
  await persist(state);

  await sleep(10000);
  return state;
}

async function runIterationFactory(
  config: Config,
  persist: State => Promise<void>
): Promise<(state: State) => Promise<State>> {
  const augur = new Augur();

  const web3 = new Web3(
    new (config.ethereumNode.startsWith("ws")
      ? Web3.providers.WebsocketProvider
      : Web3.providers.HttpProvider)(config.ethereumNode)
  );

  const account = web3.eth.accounts.privateKeyToAccount(
    "0x" + config.executionPrivateKey
  );
  web3.eth.accounts.wallet.add(account);
  web3.eth.defaultAccount = account.address;

  console.log(`Using account ${account.address} for execution`);

  await new Promise((resolve, reject) =>
    augur.connect(
      { ethereumNode: {}, augurNode: config.augurNode },
      (err, connectionInfo) => {
        if (err) {
          reject(err);
        } else {
          resolve(connectionInfo);
        }
      }
    )
  );

  return state => runIteration(augur, web3, config, state, persist);
}

export default runIterationFactory;
