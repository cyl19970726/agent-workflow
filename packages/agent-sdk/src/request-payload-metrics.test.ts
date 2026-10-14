import { describe, expect, it } from "vitest";
import { inlineImageHash, measureRequestPayload } from "./request-payload-metrics.js";

describe("measureRequestPayload", () => {
  it("counts the Responses wire shape, Unicode text, duplicate inline images, and function arguments without retaining content", () => {
    const secretText = "private text 雪😀";
    const secretArgs = '{"caption":"private argument 🧪"}';
    const imageUrl = "data:image/png;base64,YWJj"; // three decoded bytes
    const wireBody = {
      input: [
        { role: "user", content: [{ type: "input_text", text: secretText },
          { type: "input_image", image_url: imageUrl, detail: "high" },
          { type: "input_image", image_url: imageUrl, detail: "low" },
          { type: "input_image", image_url: "https://media.example/private-image" }] },
        { type: "function_call", name: "write", arguments: secretArgs },
      ],
    };
    const serialized = JSON.stringify(wireBody);
    const metrics = measureRequestPayload(wireBody, serialized);

    expect(metrics).toEqual({
      requestBodyBytes: Buffer.byteLength(serialized, "utf8"),
      inputImageOccurrences: 3,
      uniqueInputImageHashes: [inlineImageHash("image/png", "YWJj")],
      inlineImageDecodedBytes: 6,
      functionCallArgumentBytes: Buffer.byteLength(secretArgs, "utf8"),
      inputTextBytes: Buffer.byteLength(secretText, "utf8"),
      nonInlineInputImageOccurrences: 1,
    });
    expect(JSON.stringify(metrics)).not.toContain(secretText);
    expect(JSON.stringify(metrics)).not.toContain(secretArgs);
    expect(JSON.stringify(metrics)).not.toContain("YWJj");
    expect(JSON.stringify(metrics)).not.toContain("https://media.example");
  });

  it("ignores invalid inline image encodings for decoded-byte and hash metrics", () => {
    const wireBody = { input: [{ role: "user", content: [
      { type: "input_image", image_url: "data:image/png;base64,not-base64!" },
      { type: "input_image", image_url: "data:image/png;base64,YWI" },
    ] }] };
    const serialized = JSON.stringify(wireBody);
    expect(measureRequestPayload(wireBody, serialized)).toMatchObject({
      requestBodyBytes: Buffer.byteLength(serialized, "utf8"),
      inputImageOccurrences: 2,
      uniqueInputImageHashes: [],
      inlineImageDecodedBytes: 0,
      nonInlineInputImageOccurrences: 2,
    });
  });
});
