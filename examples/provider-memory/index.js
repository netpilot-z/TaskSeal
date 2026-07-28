const manifest = Object.freeze({
  schemaVersion: 1,
  apiVersion:
    "taskseal.provider/v1",
  providerId:
    "example.memory",
  capabilities: Object.freeze([
    "provider.health",
    "work-item.read"
  ]),
  configuration: Object.freeze({
    schemaVersion: 1,
    fields: Object.freeze([
      Object.freeze({
        key: "namespace",
        type: "string",
        required: true,
        secret: false
      })
    ])
  }),
  credential: Object.freeze({
    mode: "none"
  }),
  scopes: Object.freeze([
    Object.freeze({
      kind: "namespace",
      objectTypes:
        Object.freeze([
          "work-item"
        ])
    })
  ])
});

export function createMemoryProviderAdapter() {
  return {
    manifest,
    ports: {
      async "provider.health"(
        request
      ) {
        return {
          status: "ready",
          namespace:
            request.namespace
        };
      },
      async "work-item.read"(
        request
      ) {
        return {
          id: request.id,
          title:
            "Memory work item"
        };
      }
    }
  };
}
