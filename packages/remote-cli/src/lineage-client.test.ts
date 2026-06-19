import { describe, expect, it } from "vitest";
import { leaseHeaders } from "./lineage-client.js";

describe("leaseHeaders", () => {
  it("returns empty object when lease is undefined", () => {
    expect(leaseHeaders(undefined)).toEqual({});
  });

  it("returns X-Lineage-Id and X-Lineage-Epoch headers", () => {
    expect(leaseHeaders({ lineageId: "lin_abc", epoch: 3 })).toEqual({
      "X-Lineage-Id": "lin_abc",
      "X-Lineage-Epoch": "3",
    });
  });

  it("serialises epoch 0 correctly", () => {
    expect(leaseHeaders({ lineageId: "lin_x", epoch: 0 })).toEqual({
      "X-Lineage-Id": "lin_x",
      "X-Lineage-Epoch": "0",
    });
  });
});
