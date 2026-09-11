#!/usr/bin/env node
import { aggregateCalibrationSelectionView } from "../src/calibration.js";

let bytes = "";
for await (const chunk of process.stdin) bytes += chunk;
const request = JSON.parse(bytes);
const allowed = ["rows"];
if (!request || Object.keys(request).sort().join(",") !== allowed.join(","))
  throw new Error("selector IPC received unauthorized capabilities");
const result = aggregateCalibrationSelectionView(request.rows);
process.stdout.write(JSON.stringify(result));
