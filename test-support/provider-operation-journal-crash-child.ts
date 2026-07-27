import {
  FileProviderOperationJournalStorage
} from "../src/storage/provider-operation-journal.ts";
import {
  ProviderOperationJournal
} from "../src/application/provider-operation-journal.ts";
import type {
  ControlledWriteOperation
} from "../src/application/controlled-write-operation.ts";

const [
  workspaceRoot,
  crashStage,
  encodedOperation
] = process.argv.slice(2);

if (
  workspaceRoot === undefined ||
  (crashStage !== "after-temporary-sync" &&
    crashStage !== "after-rename") ||
  encodedOperation === undefined
) {
  process.exit(92);
}

const operation = JSON.parse(
  Buffer.from(encodedOperation, "base64url").toString(
    "utf8"
  )
) as ControlledWriteOperation;
const journal = await ProviderOperationJournal.open({
  storage: new FileProviderOperationJournalStorage({
    workspaceRoot,
    failureInjector(stage) {
      if (stage === crashStage) {
        process.exit(91);
      }
    }
  })
});

await journal.compareAndAppend({
  expectedVersion: 0,
  operationKey: operation.plan.operationKey,
  planDigest: operation.plan.planDigest,
  next: operation
});
