import assert from "node:assert/strict";
import { deriveVerificationStatus } from "../src/face-verification.js";

const passing = {
  Liveness_Check: "Passed",
  Selfie_Check: "Passed",
  Selfie_Provided: "Passed",
  Register_Selfie: "Approved"
};

const cases: Array<{ name: string; resultCode: string; actions: Record<string, unknown>; expected: string }> = [
  { name: "machine-approved registration with explicit passing checks", resultCode: "0840", actions: passing, expected: "verified" },
  { name: "human-approved registration with explicit passing checks", resultCode: "1240", actions: passing, expected: "verified" },
  { name: "missing registration approval must not pass", resultCode: "0840", actions: { Liveness_Check: "Passed", Selfie_Check: "Passed", Selfie_Provided: "Passed" }, expected: "pending" },
  { name: "missing liveness result must not pass", resultCode: "0840", actions: { ...passing, Liveness_Check: undefined }, expected: "pending" },
  { name: "missing selfie result must not pass", resultCode: "0840", actions: { ...passing, Selfie_Check: undefined }, expected: "pending" },
  { name: "missing usable-selfie result must not pass", resultCode: "0840", actions: { ...passing, Selfie_Provided: undefined }, expected: "pending" },
  { name: "suspected spoof remains under review", resultCode: "0844", actions: passing, expected: "under_review" },
  { name: "deprecated pending-spoof result remains under review", resultCode: "0846", actions: passing, expected: "under_review" },
  { name: "provisional registration remains under review", resultCode: "0840", actions: { ...passing, Register_Selfie: "Provisionally Approved" }, expected: "under_review" },
  { name: "human liveness review cannot be bypassed", resultCode: "0840", actions: { ...passing, Human_Review_Liveness_Check: "Under Review" }, expected: "under_review" },
  { name: "pending human review overrides a machine pass", resultCode: "0840", actions: { ...passing, Human_Review_Liveness_Check: "Under Review" }, expected: "under_review" },
  { name: "pending human selfie review overrides a machine pass", resultCode: "0840", actions: { ...passing, Human_Review_Selfie_Check: "Under Review" }, expected: "under_review" },
  { name: "human review can resolve an inconclusive machine liveness check", resultCode: "1240", actions: { ...passing, Liveness_Check: "Under Review", Human_Review_Liveness_Check: "Passed" }, expected: "verified" },
  { name: "human review can resolve an inconclusive machine selfie check", resultCode: "1240", actions: { ...passing, Selfie_Check: "Under Review", Human_Review_Selfie_Check: "Passed" }, expected: "verified" },
  { name: "human review unable to determine stays under review", resultCode: "1240", actions: { ...passing, Liveness_Check: "Under Review", Human_Review_Liveness_Check: "Unable To Determine" }, expected: "under_review" },
  { name: "failed human selfie review rejects", resultCode: "0840", actions: { ...passing, Human_Review_Selfie_Check: "Failed" }, expected: "rejected" },
  { name: "machine spoof rejection rejects", resultCode: "0841", actions: passing, expected: "rejected" },
  { name: "no-face result rejects", resultCode: "0941", actions: passing, expected: "rejected" },
  { name: "unusable-image result rejects", resultCode: "0942", actions: passing, expected: "rejected" },
  { name: "provider input errors fail closed", resultCode: "2205", actions: passing, expected: "failed" },
  { name: "documented 23xx provider errors fail closed", resultCode: "2301", actions: passing, expected: "failed" },
  { name: "documented 24xx provider errors fail closed", resultCode: "2401", actions: passing, expected: "failed" },
  { name: "unknown result remains pending", resultCode: "9999", actions: passing, expected: "pending" }
];

for (const testCase of cases) {
  assert.equal(
    deriveVerificationStatus(testCase.resultCode, testCase.actions),
    testCase.expected,
    testCase.name
  );
}
console.log(`Face/liveness result checks passed: ${cases.length}`);
