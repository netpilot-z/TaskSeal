import {
  FileEventJournal
} from "../src/storage/event-journal.ts";

const [filePath, crashStage, encodedRecord] =
  process.argv.slice(2);
const record = JSON.parse(
  Buffer.from(encodedRecord, "base64url").toString(
    "utf8"
  )
);
const journal = new FileEventJournal({
  filePath,
  atomicReplaceProbe: async () => true,
  failureInjector(stage, operation) {
    if (
      operation === "batch" &&
      stage === crashStage
    ) {
      process.exit(91);
    }
  }
});

await journal.commitBatch(record);
