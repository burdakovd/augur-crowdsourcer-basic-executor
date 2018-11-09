// @flow

import yargs from "yargs";
import * as fs from "fs-extra";
import loadConfig from "./config";
import { loadState, serializeState, saveState } from "./state";
import runIterationFactory from "./runIteration";
import type { State } from "./state";

async function printConfig(argv): Promise<void> {
  const config = await loadConfig(argv.config);
  console.log(JSON.stringify(config));
}

async function printState(argv): Promise<void> {
  const state = await loadState(argv.state);
  console.log(serializeState(state));
}

async function run(argv): Promise<void> {
  require("log-timestamp");

  const config = await loadConfig(argv.config);

  const persist = async (state: State): Promise<void> => {
    await saveState(state, argv.state + ".tmp");
    await fs.rename(argv.state + ".tmp", argv.state);
  };

  const runIteration = await runIterationFactory(config, persist);

  var state = await loadState(argv.state);
  var i = 0;
  while (true) {
    try {
      console.log(`Running iteration ${i}`);
      state = await runIteration(state);
      console.log(`Finished iteration ${i}`);
      await persist(state);
    } catch (e) {
      console.error(`Failed iteration ${i}`);
      console.error(e.stack);
    }
    i += 1;
  }
}

function main() {
  // eslint-disable-next-line no-unused-expressions
  yargs
    .usage("$0 command")
    .command("printConfig", "print config", y => y, argv => printConfig(argv))
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
