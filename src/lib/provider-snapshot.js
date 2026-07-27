import {
  digestCanonicalJson
} from "./canonical-json.ts";

export function digestProviderFactContent(fact) {
  return digestCanonicalJson({
    sourceObject: fact.sourceObject,
    observed: fact.observed
  });
}
