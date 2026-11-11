/**
 * Refuses new member passwords that an attacker would try first (NIST SP 800-63B §5.1.1.2: check
 * new secrets against commonly used and expected values, rather than imposing composition rules).
 *
 * Member IDs are sequential, so an attacker does not have to guess *who* to try — only *what*. The
 * lockout caps guesses per account, but a spray of one popular password across every ID in a school
 * costs one attempt per account and never trips it. Keeping the most popular choices out entirely
 * is what makes that spray come back empty.
 *
 * Offline on purpose: a breached-password API would send (a hash prefix of) every new student
 * password to a third party and make setting a password depend on its uptime. The list below covers
 * the head of the distribution — the passwords sprays actually use — and the structural checks catch
 * the families the list cannot enumerate (repeats, runs, keyboard rows, the word "password" or the
 * product name with a number on the end).
 *
 * Only passwords of at least PASSWORD_MIN_LENGTH characters can reach this check, so the list holds
 * only entries that long.
 */

/** Compared after lowercasing. Common passwords of 8+ characters from public breach-frequency lists. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "password1234",
  "password!",
  "password@123",
  "passw0rd",
  "p@ssw0rd",
  "p@ssword",
  "p@ssword1",
  "p@ssw0rd1",
  "pass@123",
  "pass@1234",
  "pass1234",
  "passpass",
  "iloveyou",
  "iloveyou1",
  "iloveyou2",
  "sunshine",
  "princess",
  "princess1",
  "football",
  "football1",
  "baseball",
  "basketball",
  "superman",
  "batman123",
  "spiderman",
  "starwars",
  "pokemon1",
  "whatever",
  "trustno1",
  "welcome1",
  "welcome123",
  "welcome@123",
  "letmein1",
  "letmein123",
  "computer",
  "internet",
  "michelle",
  "jennifer",
  "jordan23",
  "charlie1",
  "midnight",
  "mustang1",
  "chocolate",
  "butterfly",
  "liverpool",
  "barcelona",
  "realmadrid",
  "manchester",
  "arsenal1",
  "chelsea1",
  "1q2w3e4r",
  "1q2w3e4r5t",
  "1qaz2wsx",
  "1qaz2wsx3edc",
  "zaq12wsx",
  "qwerty123",
  "qwerty1234",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm1",
  "aa123456",
  "abc12345",
  "abcd1234",
  "abc123456",
  "a1b2c3d4",
  "q1w2e3r4",
  "qwer1234",
  "asdf1234",
  "zxcv1234",
  "iloveu123",
  "loveyou1",
  "lovelove",
  "monkey123",
  "dragon123",
  "master123",
  "shadow123",
  "admin123",
  "admin1234",
  "administrator",
  "changeme",
  "changeme1",
  "default1",
  "secret123",
  "student1",
  "student123",
  "teacher1",
  "teacher123",
  "school123",
  "parent123",
  "myschool",
  "freedom1",
  "blink182",
  "samsung1",
  "samsung123",
  "iphone12",
  "google123",
  "facebook",
  "facebook1",
  "instagram",
  "whatsapp",
  "linkedin",
  "minecraft",
  "fortnite",
  "roblox123",
  "bismillah",
  "alhamdulillah",
  "allahuakbar",
  "muhammad",
  "mohammed",
  "mohammad",
  "palestine",
  "jerusalem",
  "baghdad1",
  "iraq1234",
  "jordan123",
  "egypt123",
  "habibi123",
  "yasmin123",
  "11223344",
  "112233445566",
  "121212121",
  "123123123",
  "123321123",
  "123454321",
  "123456aa",
  "123456ab",
  "123456abc",
  "123456qwe",
  "123qwe123",
  "123abc123",
  "147258369",
  "159357456",
  "159753456",
  "741852963",
  "789456123",
  "963852741",
  "12qwaszx",
  "qazwsxedc",
  "qweasdzxc",
  "1234qwer",
  "1234abcd",
  "00000000",
  "11111111",
  "88888888",
  "99999999",
  "12345678",
  "123456789",
  "1234567890",
  "0987654321",
  "987654321",
  "87654321",
  "01012000",
  "19901990",
  "20002000",
  "20202020",
]);

/** Product and role words that, with a number or symbol on the end, are the first thing tried here. */
const BASE_WORDS = ["password", "passw0rd", "p@ssw0rd", "studafy", "student", "teacher", "school"];

const KEYBOARD_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";

/** Whether `value` is a unit of 1–4 characters repeated ("aaaaaaaa", "abababab", "abc1abc1"). */
function isRepetition(value: string): boolean {
  for (const unit of [1, 2, 3, 4]) {
    if (value.length % unit !== 0 || value.length / unit < 2) continue;
    if (value === value.slice(0, unit).repeat(value.length / unit)) return true;
  }
  return false;
}

/** Whether `value` is a contiguous run, forwards or backwards, of one of `sequences`. */
function isRun(value: string, sequences: readonly string[]): boolean {
  return sequences.some((sequence) => {
    const reversed = [...sequence].reverse().join("");
    return sequence.includes(value) || reversed.includes(value);
  });
}

/** True when `password` is too predictable to protect an account whose ID is public. */
export function isCommonPassword(password: string): boolean {
  const lowered = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) return true;
  if (isRepetition(lowered)) return true;
  if (isRun(lowered, [...KEYBOARD_ROWS, ALPHABET, DIGITS])) return true;
  // "password2024", "Studafy@1", "1school!!": a base word wrapped only in digits and symbols.
  const stripped = lowered.replace(/^[\d\W_]+/u, "").replace(/[\d\W_]+$/u, "");
  return BASE_WORDS.some((word) => stripped === word || lowered === word);
}
