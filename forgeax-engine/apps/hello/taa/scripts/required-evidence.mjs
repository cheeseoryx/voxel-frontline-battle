export function emitRequiredUnavailable(report) {
  // A carrier is a gate, not optional telemetry: missing provider evidence
  // must fail the invoking command while retaining its structured report.
  const required = true;
  console.log(
    JSON.stringify({
      ...report,
      acceptance: 'blocked',
      exitPolicy: required ? 'fail-closed' : 'record-only',
    }),
  );
  if (required) process.exitCode = 1;
}
