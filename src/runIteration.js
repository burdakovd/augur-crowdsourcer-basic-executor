// @flow

import type { Config } from "./config";
import type { State } from "./state";
import { addMarket } from "./reducers";
import { List as ImmList } from "immutable";
import sleep from "sleep-promise";
import Augur from "augur.js";

async function findMarkets(augur: Augur, state: State): Promise<State> {
  const syncData = await new Promise((resolve, reject) =>
    augur.augurNode.getSyncData(function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    })
  );
  const marketsReceived = await Promise.all(
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
  ).then(([x, y]) => ImmList.of(...x, ...y));

  for (const address of marketsReceived) {
    if (!state.markets.contains(address)) {
      console.log(`Discovered new market: ${address}`);
      state = addMarket(state, address);
    }
  }

  return state;
}

async function runIteration(
  augur: Augur,
  config: Config,
  state: State,
  persist: State => Promise<void>
): Promise<State> {
  state = await findMarkets(augur, state);
  await persist(state);

  await sleep(10000);
  return state;
}

async function runIterationFactory(
  config: Config,
  persist: State => Promise<void>
): Promise<(state: State) => Promise<State>> {
  const augur = new Augur();

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

  return state => runIteration(augur, config, state, persist);
}

export default runIterationFactory;
