// @flow

import type { Config } from "./config";
import type { State } from "./state";
import { addMarket } from "./reducers";
import AugurCoreABI from "augur-core/output/contracts/abi.json";
import { Set as ImmSet } from "immutable";
import sleep from "sleep-promise";
import Augur from "augur.js";
import Web3 from "web3";

async function findMarkets(
  augur: Augur,
  web3: Web3,
  state: State
): Promise<State> {
  const syncData = await new Promise((resolve, reject) =>
    augur.augurNode.getSyncData(function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    })
  );
  const addresses = await Promise.all(
    ["CROWDSOURCING_DISPUTE", "AWAITING_NEXT_WINDOW"].map(
      state =>
        new Promise((resolve, reject) =>
          augur.markets.getMarkets(
            {
              universe: syncData.addresses.Universe,
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
  ).then(([x, y]) => ImmSet.of(...x, ...y));

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
        return {
          address,
          numOutcomes
        };
      })
  ).then(a => a.filter(x => x != null));

  for (const market of markets) {
    console.log(`Discovered new market: ${market.address}`);
    state = addMarket(state, market.address, {
      numOutcomes: market.numOutcomes
    });
  }

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
