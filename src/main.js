// @flow

import yargs from "yargs";
import loadConfig from "./config";
import { loadState, serializeState } from "./state";

async function printConfig(argv): Promise<void> {
  const config = await loadConfig(argv.config);
  console.log(JSON.stringify(config));
}

async function printState(argv): Promise<void> {
  const state = await loadState(argv.state);
  console.log(serializeState(state));
}

function main() {
  // eslint-disable-next-line no-unused-expressions
  yargs
    .usage("$0 command")
    .command("printConfig", "print config", y => y, argv => printConfig(argv))
    .command("printState", "print state", y => y, argv => printState(argv))
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
