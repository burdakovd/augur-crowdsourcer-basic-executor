// @flow

import yargs from "yargs";
import loadConfig from "./config";

async function printConfig(argv): Promise<void> {
  const config = await loadConfig(argv.config);
  console.log(JSON.stringify(config));
}

function main() {
  // eslint-disable-next-line no-unused-expressions
  yargs
    .usage("$0 command")
    .command("printConfig", "print config", y => y, argv => printConfig(argv))
    .demandCommand()
    .option("config", {
      describe: "path to config file",
      default: "/src/config/config.json"
    })
    .help().argv;
}

export default main;
