import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProviderAdapterV1
} from "../provider-v1.ts";
import type {
  ProviderAdapterV1
} from "../provider-v1.ts";

export interface ProviderAdapterContractFactory<
  HealthRequest = unknown,
  HealthResult = unknown,
  WorkItemRequest = unknown,
  WorkItemResult = unknown
> {
  readonly name: string;
  createAdapter(): ProviderAdapterV1<
    HealthRequest,
    HealthResult,
    WorkItemRequest,
    WorkItemResult
  >;
  readonly healthRequest:
    HealthRequest;
  readonly workItemRequest:
    WorkItemRequest;
  assertHealthResult(
    result: HealthResult
  ): void;
  assertWorkItemResult(
    result: WorkItemResult
  ): void;
}

export function registerProviderAdapterContract<
  HealthRequest,
  HealthResult,
  WorkItemRequest,
  WorkItemResult
>({
  name,
  createAdapter,
  healthRequest,
  workItemRequest,
  assertHealthResult,
  assertWorkItemResult
}: ProviderAdapterContractFactory<
  HealthRequest,
  HealthResult,
  WorkItemRequest,
  WorkItemResult
>): void {
  test(
    `${name} exposes a valid read-only v1 adapter manifest`,
    () => {
      const adapter =
        createAdapter();
      const normalized =
        normalizeProviderAdapterV1(
          adapter
        );

      assert.deepEqual(
        normalized.manifest,
        adapter.manifest
      );
      assert.deepEqual(
        Reflect.ownKeys(
          normalized.ports
        ),
        [
          "provider.health",
          "work-item.read"
        ]
      );
    }
  );

  test(
    `${name} implements every declared read-only v1 port`,
    async () => {
      const adapter =
        createAdapter();
      assertHealthResult(
        await adapter.ports[
          "provider.health"
        ](healthRequest)
      );
      assertWorkItemResult(
        await adapter.ports[
          "work-item.read"
        ](workItemRequest)
      );
    }
  );
}
