export class ReportSizeLimit extends Error {
  constructor() {
    super(
      "This report exceeds the single-file rendering budget. Choose a smaller date range.",
    );
  }
}
