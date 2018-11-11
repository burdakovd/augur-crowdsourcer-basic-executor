// @flow

import yargs from "yargs";
import * as fs from "fs-extra";
import loadConfig from "./config";
import { getInitialState, loadState, serializeState, saveState } from "./state";
import runIterationFactory from "./runIteration";
import type { State } from "./state";
import sleep from "sleep-promise";

function summarize(state: State): void {
  console.log(
    `Keeping track of ${state.markets.size} markets and ${state.markets
      .valueSeq()
      .map(({ crowdsourcers }) => crowdsourcers.size)
      .reduce((x, y) => x + y, 0)} pools now`
  );
}

async function printConfig(argv): Promise<void> {
  const config = await loadConfig(argv.config);
  console.log(JSON.stringify(config));
}

async function printState(argv): Promise<void> {
  const state = await loadState(argv.state);
  summarize(state);
  console.log(serializeState(state));
}

async function resetState(argv): Promise<void> {
  const state = getInitialState();
  summarize(state);
  await saveState(state, argv.state + ".tmp");
  await fs.rename(argv.state + ".tmp", argv.state);
}

async function run(argv): Promise<void> {
  require("log-timestamp");

  const config = await loadConfig(argv.config);
  var globalState = await loadState(argv.state);

  summarize(globalState);

  const persist = async (state: State): Promise<void> => {
    if (serializeState(state) === serializeState(globalState)) {
      return;
    }
    summarize(state);
    await saveState(state, argv.state + ".tmp");
    await fs.rename(argv.state + ".tmp", argv.state);
    globalState = state;
    console.log("Persisted state");
  };

  const runIteration = await runIterationFactory(config, persist);

  var i = 0;
  while (true) {
    try {
      console.log(`Running iteration ${i}`);
      globalState = await runIteration(globalState);
      console.log(`Finished iteration ${i}`);
      await persist(globalState);
    } catch (e) {
      console.error(`Failed iteration ${i}`);
      console.error(e.stack);
      await sleep(10000);
    }
    i += 1;
  }
}

function main() {
  // eslint-disable-next-line no-unused-expressions
  yargs
    .usage("$0 command")
    .command("printConfig", "print config", y => y, argv => printConfig(argv))
    .command("resetState", "reset state", y => y, argv => resetState(argv))
    .command("printState", "print state", y => y, argv => printState(argv))
    .command("run", "run", y => y, argv => run(argv))
    .demandCommand()
    .option("config", {
      describe: "path to config file",
      default: "/src/config/config.json"
    })
    .option("state", {
      describe: "path to state file",
      default: "/src/config/state.json"
    })
    .help().argv;
}

export default main;
