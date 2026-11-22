// Documentation helper: input is a saved, authenticated GET /v1/models response.
import { readFile } from "node:fs/promises";
const { data } = JSON.parse(await readFile(process.argv[2], "utf8"));
console.log(
  "| Model | Pi cycle / wire values | Default |\n| --- | --- | --- |",
);
for (const m of data)
  console.log(
    `| \`${m.id}\` | ${["off", "low", "high", "max"].filter((l) => m.reasoning_efforts?.includes(l)).join(" → ")} | ${m.reasoning_default ?? "unspecified"} |`,
  );
