import {
  digestCanonicalJson
} from "./canonical-json.js";

export function digestProviderFactContent(fact) {
  return digestCanonicalJson({
    sourceObject: fact.sourceObject,
    observed: fact.observed
  });
}
