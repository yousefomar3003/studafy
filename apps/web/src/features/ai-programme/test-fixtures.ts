/**
 * Fixtures for the Student AI dashboards' page tests: the spec's worked example (500 enrolled, 350
 * opted in, 10 months, uploads on 85% of school days -> 13%, a $1,820 share, a $7,000 margin,
 * $8,820 earned, Studafy keeps $12,180 = $34.80 a seat), as the API answers it.
 */

export const SCHOOL_ID = "10000000-0000-4000-8000-000000000001";
export const LICENSE_ID = "20000000-0000-4000-8000-000000000002";
export const INVOICE_ID = "30000000-0000-4000-8000-000000000003";
export const CREDIT_INVOICE_ID = "30000000-0000-4000-8000-000000000004";
const YEAR_ID = "40000000-0000-4000-8000-000000000005";

const TIERS = {
  conversion: [
    { fromBps: 0, shareBps: 0 },
    { fromBps: 2500, shareBps: 400 },
    { fromBps: 4000, shareBps: 600 },
    { fromBps: 5500, shareBps: 800 },
    { fromBps: 7000, shareBps: 1000 },
    { fromBps: 8500, shareBps: 1200 },
  ],
  bonus: [
    { fromBps: 0, shareBps: 0 },
    { fromBps: 6000, shareBps: 150 },
    { fromBps: 8000, shareBps: 300 },
  ],
};

export function dashboard(overrides: Record<string, unknown> = {}) {
  return {
    schoolId: SCHOOL_ID,
    today: "2026-11-18",
    license: {
      id: LICENSE_ID,
      status: "active",
      commitment: "full_year",
      startsOn: "2026-09-01",
      endsOn: "2027-06-30",
      studentSeats: 350,
      currencyCode: "USD",
      minorUnit: 2,
      inProgramme: true,
    },
    academicYear: {
      id: YEAR_ID,
      name: "2026-2027",
      startsOn: "2026-09-01",
      endsOn: "2027-06-30",
      months: 10,
    },
    currencyCode: "USD",
    minorUnit: 2,
    values: {
      licensePriceMinor: 400,
      parentPriceMinor: 600,
      maxShareBps: 1500,
      conversionTiers: TIERS.conversion,
      contentBonusTiers: TIERS.bonus,
      largeSchoolMinSeats: 500,
      largeSchoolShareBps: 800,
      bonusRequiresConversionShare: true,
      monthToMonthShareBps: 0,
      measurementOffsetDays: 30,
      payoutMode: "invoice_credit",
    },
    students: { enrolled: 500, optedIn: 350, conversionBps: 7000 },
    conversion: {
      periodStart: "2026-09-01",
      measureOn: "2026-10-01",
      source: "locked",
      enrolled: 500,
      optedIn: 350,
      conversionBps: 7000,
      seats: 350,
      tierFromBps: 7000,
      shareBps: 1000,
      floorApplied: false,
    },
    nextTier: { fromBps: 8500, shareBps: 1200, optInsNeeded: 75 },
    largeSchoolFloor: null,
    uploads: {
      from: "2026-09-01",
      to: "2026-11-17",
      schoolDays: 50,
      classesCounted: 2,
      consistencyBps: 8500,
      tierFromBps: 8000,
      tierBonusBps: 300,
      aimBps: 8000,
    },
    rate: {
      conversionShareBps: 1000,
      bonusBps: 300,
      capped: false,
      multiplierBps: 10000,
      totalBps: 1300,
    },
    ledger: {
      currencyCode: "USD",
      minorUnit: 2,
      baseMinor: 1_400_000,
      pendingMinor: 0,
      owedMinor: 145_600,
      creditedMinor: 36_400,
      payoutDueMinor: 0,
      paidOutMinor: 0,
      forfeitedMinor: 0,
      earnedMinor: 182_000,
    },
    earnings: {
      share: {
        collectedMinor: 1_400_000,
        earnedMinor: 182_000,
        pendingMinor: 0,
        owedMinor: 145_600,
        creditedMinor: 36_400,
        payoutDueMinor: 0,
        paidOutMinor: 0,
        forfeitedMinor: 0,
      },
      margin: {
        basis: "collected",
        autoBilling: true,
        perStudentMonthMinor: 200,
        lines: 350,
        billedMinor: 700_000,
        collectedMinor: 700_000,
        estimatedMinor: 0,
        expectedMinor: 700_000,
      },
      totalMinor: 882_000,
      estimated: false,
    },
    studafy: {
      invoicedMinor: 1_400_000,
      paidMinor: 1_260_000,
      outstandingMinor: 140_000,
      overdueMinor: 0,
      sharesCreditedMinor: 36_400,
    },
    ...overrides,
  };
}

export function platformDashboard(overrides: Record<string, unknown> = {}) {
  return {
    ...dashboard(overrides),
    schoolName: "Atlas Academy",
    studafyNet: { netMinor: 1_218_000, perSeatMinor: 3480, seats: 350 },
  };
}

export function entry(position: number, overrides: Record<string, unknown> = {}) {
  const month = String(8 + position).padStart(2, "0");
  return {
    id: `e0000000-0000-4000-8000-00000000000${position}`,
    kind: "share",
    reversesEntryId: null,
    licenseId: LICENSE_ID,
    invoiceId: INVOICE_ID,
    invoiceNumber: "LIC-2026-000001",
    paymentId: `p0000000-0000-4000-8000-00000000000${position}`,
    instalmentId: `i0000000-0000-4000-8000-00000000000${position}`,
    instalmentPosition: position,
    receivedOn: `2026-${month}-01`,
    periodFrom: `2026-${month}-01`,
    periodTo: `2026-${month}-30`,
    measurementPeriodStart: "2026-09-01",
    currencyCode: "USD",
    minorUnit: 2,
    collectedMinor: 140_000,
    baseMinor: 140_000,
    commitment: "full_year",
    programmeVersionId: "a1000000-0000-4000-8000-000000000001",
    programmeOverrideId: null,
    seats: 350,
    conversionBps: 7000,
    conversionShareBps: 1000,
    floorApplied: false,
    uploadConsistencyBps: 8500,
    bonusBps: 300,
    capped: false,
    multiplierBps: 10000,
    totalBps: 1300,
    amountMinor: 18_200,
    conversionPending: false,
    bonusPending: false,
    status: "owed",
    computedAt: "2026-10-02T00:00:00.000Z",
    creditInvoiceId: null,
    creditInvoiceNumber: null,
    creditedAt: null,
    payoutId: null,
    forfeitedAt: null,
    forfeitReason: null,
    voidedAt: null,
    ...overrides,
  };
}

export function ledger(overrides: Record<string, unknown> = {}) {
  return {
    totals: [dashboard().ledger],
    entries: [
      entry(2),
      entry(1, {
        status: "credited",
        creditInvoiceId: CREDIT_INVOICE_ID,
        creditInvoiceNumber: "LIC-2026-000010",
        creditedAt: "2026-10-05T00:00:00.000Z",
      }),
    ],
    payouts: [],
    ...overrides,
  };
}

export function uploads(overrides: Record<string, unknown> = {}) {
  return {
    timezone: "Africa/Casablanca",
    today: "2026-11-18",
    from: "2026-09-01",
    to: "2026-11-18",
    countedTo: "2026-11-17",
    basis: "license",
    schoolDays: 50,
    classesCounted: 2,
    consistencyBps: 8500,
    classes: [
      {
        classId: "c0000000-0000-4000-8000-000000000001",
        code: "ALG-1",
        courseName: "Algebra",
        sectionId: null,
        schoolDays: 50,
        uploadDays: 48,
        consistencyBps: 9600,
        teacherIds: ["t1"],
      },
      {
        classId: "c0000000-0000-4000-8000-000000000002",
        code: "SCI-1",
        courseName: "Science",
        sectionId: null,
        schoolDays: 50,
        uploadDays: 37,
        consistencyBps: 7400,
        teacherIds: ["t2"],
      },
    ],
    teachers: [
      {
        teacherId: "t1",
        userId: "u1",
        name: "Amal Idrissi",
        classIds: ["c0000000-0000-4000-8000-000000000001"],
        consistencyBps: 9600,
      },
      {
        teacherId: "t2",
        userId: "u2",
        name: "Karim Benali",
        classIds: ["c0000000-0000-4000-8000-000000000002"],
        consistencyBps: 7400,
      },
    ],
    bonus: {
      licenseId: LICENSE_ID,
      source: "license",
      tiers: TIERS.bonus,
      tier: { fromBps: 8000, shareBps: 300 },
      nextTier: null,
      targetBps: 6000,
    },
    ...overrides,
  };
}

export function schoolRow(overrides: Record<string, unknown> = {}) {
  return {
    schoolId: SCHOOL_ID,
    schoolName: "Atlas Academy",
    licenseId: LICENSE_ID,
    licenseStatus: "active",
    commitment: "full_year",
    inProgramme: true,
    studentSeats: 350,
    currencyCode: "USD",
    minorUnit: 2,
    enrolled: 500,
    optedIn: 350,
    liveConversionBps: 7000,
    conversionBps: 7000,
    conversionSource: "locked",
    conversionShareBps: 1000,
    uploadConsistencyBps: 8500,
    bonusBps: 300,
    totalBps: 1300,
    collectedMinor: 1_400_000,
    pendingMinor: 0,
    owedMinor: 182_000,
    creditedMinor: 0,
    payoutDueMinor: 0,
    paidOutMinor: 0,
    forfeitedMinor: 0,
    earnedMinor: 182_000,
    studafyNetMinor: 1_218_000,
    studafyNetPerSeatMinor: 3480,
    ...overrides,
  };
}
