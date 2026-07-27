import {
  FileEventJournal
} from "../src/storage/event-journal.js";

const [filePath] = process.argv.slice(2);
const journal = new FileEventJournal({ filePath });

try {
  await journal.readAll();
  process.stderr.write(
    "Oversized journal record was accepted.\n"
  );
  process.exitCode = 1;
} catch (error) {
  if (error?.code === "JOURNAL_CORRUPT") {
    process.stdout.write("JOURNAL_CORRUPT\n");
  } else {
    process.stderr.write(
      `${error?.stack ?? String(error)}\n`
    );
    process.exitCode = 1;
  }
}
