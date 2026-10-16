import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";

const filePath = process.argv[2];
if (!filePath) throw new Error("missing personal config path");
const repository = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
try {
  const snapshot = await repository.read();
  await new Promise<void>((resolve, reject) => {
    process.send?.(
      {
        providers: snapshot.providers.keys(),
        defaultModelSelection: snapshot.defaultModelSelection,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
} finally {
  repository.dispose();
  process.disconnect?.();
}
