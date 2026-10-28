import { leadGenDailyReports } from "./leadGenDaily";
import { leadGenOriginReports } from "./leadGenOrigins";
import { leadGenPeopleReports } from "./leadGenPeople";

// Operations › Lead Gen (`lead_gen`) and My Activity (`my_activity`). The
// shared capture SQL and the unique-credit rule are in leadGenShared.ts.
export const leadGenReports = [
  ...leadGenDailyReports,
  ...leadGenOriginReports,
  ...leadGenPeopleReports,
];
