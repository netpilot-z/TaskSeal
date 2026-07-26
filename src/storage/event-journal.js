import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export class FileEventJournal {
  constructor({ filePath }) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) {
      throw new TypeError("Event journal filePath must be a non-empty string.");
    }

    this.filePath = filePath;
  }

  async readAll() {
    let content;

    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }

      throw new JournalError(
        "JOURNAL_READ_FAILED",
        "TaskSeal could not read the local event journal.",
        { cause: error }
      );
    }

    const events = [];
    const lines = content.split(/\r?\n/);

    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) {
        continue;
      }

      try {
        events.push(JSON.parse(line));
      } catch (error) {
        throw new JournalError(
          "JOURNAL_CORRUPT",
          `TaskSeal event journal contains invalid JSON at line ${index + 1}.`,
          { cause: error }
        );
      }
    }

    return events;
  }

  async append(event) {
    let handle;

    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      handle = await open(this.filePath, "a");
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      throw new JournalError(
        "JOURNAL_WRITE_FAILED",
        "TaskSeal could not append to the local event journal.",
        { cause: error }
      );
    } finally {
      await handle?.close();
    }
  }
}

export class JournalError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "JournalError";
    this.code = code;
  }
}

