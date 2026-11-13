# Store audience and age ratings

The answers for Play Console → App content (Target audience and content, Ads, content rating) and
for App Store Connect → Age Rating, each tied to the fact in the app that supports it. ST-309
produced this page. The reasoning behind the answers (children's-data basis, no ads, no age screen)
is in [`childrens-data-dossier.md`](childrens-data-dossier.md). The Data safety and App Privacy
answers are in `apps/mobile/store/privacy-labels.md` and are not repeated here.

**None of this has been submitted.** Neither console has an app record yet
(`docs/runbooks/mobile-release.md`, Status). Record each submission in
[Submission record](#submission-record) when it happens.

Both questionnaires change their wording over time. Answer the questions as the console shows them
on the day, using the facts below. Where a question has no row here, answer it from the code and add
the row. Do not answer from memory or from a previous submission.

## Play Console: Target audience and content

| Question                                                    | Answer                                                                                                  | Fact                                                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target age groups                                           | **5 and under, 6–8, 9–12, 13–15, 16–17, 18 and over**                                                   | Schools give sign-ins to students of every school age, kindergarten included (confirmed by the business on 2026-10-02). Parents and teachers are adults |
| Families policy                                             | Applies, because under-13 groups are selected. Accept the Families policy requirements                  | ST-307's SDK audit already meets the Families data rules (`sdk_compliance_inventory.md`)                                                                |
| Could the store listing unintentionally appeal to children? | Not asked once under-13 groups are selected. If it is, answer from the listing in `listing-metadata.md` |                                                                                                                                                         |
| Teacher Approved                                            | Not applied for                                                                                         | Optional programme                                                                                                                                      |

Selecting under-13 groups commits the app to the Families policy for every release: no AAID or
other restricted identifiers, only Families-certified ads SDKs (there are none), a privacy policy,
and content suitable for the youngest selected group, which here is 5 and under.
`child_directed_sdks_test.dart` enforces the SDK half.

## Countries and regions

| Console           | Setting                                                   | Answer          | Fact                                                                                     |
| ----------------- | --------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| Play              | Production → Countries / regions                          | **Jordan only** | Studafy operates only in Jordan, and the dossier documents a legal basis for Jordan only |
| App Store Connect | Pricing and Availability → Country or Region Availability | **Jordan only** | Same                                                                                     |

Add a country here only after the dossier has a counsel-reviewed row for it.

## Ads

| Question                   | Answer | Fact                                                                                                                                                                                                                                       |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does your app contain ads? | **No** | No ads SDK in the lockfile, transitive dependencies included (`child_directed_sdks_test.dart`). No house ads. The AI-not-active screen is a feature state with no price, link or button (ST-304). See the dossier's open question about it |

## Play Console: Content rating (IARC)

| Question                                                                                 | Answer                         | Fact                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Category                                                                                 | Reference, news or educational | A school-records and study app (`listing-metadata.md`)                                                                                                                            |
| Violence, fear, sexuality, language, controlled substances, crude humour, discrimination | **No** to each                 | The app shows timetables, grades, attendance, materials and announcements. Discipline incidents are text records, not depictions                                                  |
| Gambling, real or simulated                                                              | **No**                         | No games of chance, no wagers, no loot boxes                                                                                                                                      |
| Users can interact or exchange content                                                   | **Yes**                        | Teachers post announcements and materials that students see. Schools send messages to parents. Students cannot message each other (`parent_communication_screen.dart` is one-way) |
| Shares the user's location                                                               | **No**                         | No location permission (`privacy-labels.md`)                                                                                                                                      |
| Digital purchases                                                                        | **No**                         | Nothing is sold in the app (`docs/store_payment_routing.md`)                                                                                                                      |
| Unrestricted internet access                                                             | **No**                         | No in-app browser or webview. The app opens fixed first-party pages and school payment pages in the system browser                                                                |
| Generative AI content, if asked                                                          | **Yes**                        | Ask AI, quizzes, flashcards and summaries. Every output has a Report action and a moderation queue (`docs/runbooks/ai-content-moderation.md`)                                     |

Expected result: Everyone / PEGI 3, with a "Users Interact" interactive element. Record the rating
IARC actually issues, not this expectation.

## App Store Connect: Age Rating

| Question                                                                                                                                                                                         | Answer            | Fact                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Violence (cartoon or realistic), sexual content or nudity, profanity, horror, alcohol/tobacco/drugs, mature or suggestive themes, medical or treatment information, simulated gambling, contests | **None** for each | As for IARC above                                                                                                                                                                                                                                                                                                                |
| Unrestricted web access                                                                                                                                                                          | **No**            | No in-app browser                                                                                                                                                                                                                                                                                                                |
| User-generated content                                                                                                                                                                           | **Yes**           | Staff-uploaded materials and announcements, student submissions, AI output. Reporting is in-app (ST-306)                                                                                                                                                                                                                         |
| Messaging and chat                                                                                                                                                                               | **Yes**           | Teachers and schools send announcements and messages that students and parents read. There is no student-to-student messaging. "Yes" is the truthful answer even though no one can reply                                                                                                                                         |
| Advertising                                                                                                                                                                                      | **No**            | As for Play                                                                                                                                                                                                                                                                                                                      |
| Parental controls                                                                                                                                                                                | **No**            | Parents can view their children's records but cannot restrict the app                                                                                                                                                                                                                                                            |
| Age assurance                                                                                                                                                                                    | **No**            | The app never asks for or estimates an age (dossier, [Age screen](childrens-data-dossier.md#age-screen))                                                                                                                                                                                                                         |
| Made for Kids / Kids Category                                                                                                                                                                    | **Do not select** | Guideline 1.3 requires a parental gate before any link out of the app, and this app opens the system browser for sign-in, fees and the privacy policy. It also bars sending device information to third parties, and this app sends crash reports with device details to Firebase and Sentry. Teachers and parents are users too |

Expected result: 4+ if every content answer is "None". If App Store Connect computes a higher rating
because of a capability answer, accept it. Do not change a truthful answer to lower the rating.

## Consistency rules

- The age groups above, the Families acceptance, and the "no ads" answer must stay consistent with
  `sdk_compliance_inventory.md` and with the Data safety answers in `privacy-labels.md`.
- Change these answers when any of the following ships: an age-dependent feature
  (`age_branching_test.dart` fails first), a messaging feature between students, an in-app browser,
  an ads or analytics SDK, an in-app purchase, or a new country.

## Submission record

| Console           | Section                        | Submitted by | Date | Result (rating, certificate ID) |
| ----------------- | ------------------------------ | ------------ | ---- | ------------------------------- |
| Play              | Countries / regions            |              |      |                                 |
| Play              | Target audience and content    |              |      |                                 |
| Play              | Ads                            |              |      |                                 |
| Play              | Content rating (IARC)          |              |      |                                 |
| App Store Connect | Country or Region Availability |              |      |                                 |
| App Store Connect | Age Rating                     |              |      |                                 |
