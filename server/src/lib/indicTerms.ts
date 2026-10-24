// Dish and ride words written in Indian scripts, read as the English words the
// catalogue and the chat's reader know.
//
// The catalogue's keywords and the reader's vocabulary are English, so
// "बिरयानी" or "పిజ్జా" matched nothing: search showed the whole menu as a
// substitute, and the chat answered that it could not help. The app is offered
// in Hindi, Marathi, Kannada, Tamil and Telugu, so these are the words its
// readers type.
//
// Only words with one clear meaning in a food or ride app are listed. A word
// that is also an everyday verb or noun ("करी" is "did" as often as "curry")
// stays out, because turning it into a dish would put words in the
// customer's mouth.

const TERMS: Record<string, string[]> = {
  biryani: ["बिरयानी", "बिरियानी", "बिर्याणी", "ಬಿರಿಯಾನಿ", "பிரியாணி", "బిర్యానీ", "బిర్యాని", "బిరియాని"],
  pizza: ["पिज्जा", "पिझ्झा", "पीजा", "ಪಿಜ್ಜಾ", "ಪಿಝಾ", "பீட்சா", "பிட்சா", "பிஸ்ஸா", "పిజ్జా", "పిజా"],
  burger: ["बर्गर", "ಬರ್ಗರ್", "பர்கர்", "బర్గర్"],
  dosa: ["डोसा", "दोसा", "ದೋಸೆ", "ದೋಸಾ", "தோசை", "தோசா", "దోస", "దోశ", "దోసె"],
  pasta: ["पास्ता", "ಪಾಸ್ತಾ", "பாஸ்தா", "పాస్తా"],
  noodle: ["नूडल्स", "नूडल", "ನೂಡಲ್ಸ್", "நூடுல்ஸ்", "నూడుల్స్"],
  thali: ["थाली", "थाळी", "ಥಾಲಿ", "தாலி", "థాలీ", "తాలీ"],
  meals: ["मील्स", "ಮೀಲ್ಸ್", "மீல்ஸ்", "మీల్స్"],
  paneer: ["पनीर", "ಪನೀರ್", "பனீர்", "పనీర్"],
  samosa: ["समोसा", "ಸಮೋಸ", "சமோசா", "సమోసా"],
  idli: ["इडली", "ಇಡ್ಲಿ", "இட்லி", "ఇడ్లీ", "ఇడ్లి"],
  vada: ["वडा", "ವಡೆ", "ವಡಾ", "வடை", "వడ"],
  paratha: ["पराठा", "परांठा", "ಪರೋಟ", "ಪರಾಠಾ", "பரோட்டா", "పరోటా", "పరాఠా"],
  roll: ["रोल", "ರೋಲ್", "ரோல்", "రోల్"],
  momo: ["मोमो", "ಮೋಮೋ", "மோமோ", "మోమో"],
  cake: ["केक", "ಕೇಕ್", "கேக்", "కేక్"],
  "ice cream": ["आइसक्रीम", "ಐಸ್ಕ್ರೀಮ್", "ஐஸ்கிரீம்", "ఐస్క్రీమ్"],
  rice: ["राइस", "चावल", "ರೈಸ್", "ரைஸ்", "రైస్"],
  sandwich: ["सैंडविच", "सँडविच", "ಸ್ಯಾಂಡ್ವಿಚ್", "சாண்ட்விச்", "శాండ్విచ్"],
  salad: ["सलाद", "सॅलड", "ಸಲಾಡ್", "சாலட்", "సలాడ్"],
  soup: ["सूप", "ಸೂಪ್", "சூப்", "సూప్"],
  kebab: ["कबाब", "ಕಬಾಬ್", "கபாப்", "కబాబ్"],
  tikka: ["टिक्का", "ಟಿಕ್ಕಾ", "டிக்கா", "టిక్కా"],
  chicken: ["चिकन", "ಚಿಕನ್", "சிக்கன்", "చికెన్"],
  mushroom: ["मशरूम", "ಮಶ್ರೂಮ್", "காளான்", "మష్రూమ్"],
  chocolate: ["चॉकलेट", "ಚಾಕೊಲೇಟ್", "சாக்லேட்", "చాక్లెట్"],
  veg: ["वेज", "व्हेज", "शाकाहारी", "ವೆಜ್", "ಸಸ್ಯಾಹಾರಿ", "வெஜ்", "சைவ", "వెజ్", "శాకాహార"],
  breakfast: ["नाश्ता", "ಉಪಾಹಾರ", "டிபன்", "అల్పాహారం", "టిఫిన్"],
  lunch: ["लंच", "ಲಂಚ್", "லஞ்ச்", "లంచ్"],
  dinner: ["डिनर", "ಡಿನ್ನರ್", "டின்னர்", "డిన్నర్"],
  cab: ["कैब", "कॅब", "ಕ್ಯಾಬ್", "கேப்", "క్యాబ్"],
  auto: ["ऑटो", "रिक्शा", "रिक्षा", "ಆಟೋ", "ஆட்டோ", "ఆటో"],
  bike: ["बाइक", "बाईक", "ಬೈಕ್", "பைக்", "బైక్"],
  taxi: ["टैक्सी", "टॅक्सी", "ಟ್ಯಾಕ್ಸಿ", "டாக்ஸி", "టాక్సీ"],
  ride: ["राइड", "ರೈಡ್", "ரைடு", "రైడ్"],
};

/**
 * One spelling for the variants a keyboard produces: the nukta (ज़ and ज are
 * typed both ways for the same English sound) and the zero-width joiners
 * Kannada and Telugu keyboards insert inside words.
 */
function normalise(s: string): string {
  return s.normalize("NFC").replace(/[़‌‍]/g, "");
}

// Everyday words that begin with a listed word: cucumber is not a dosa.
const NOT_TERMS = ["దోసకాయ"].map(normalise);

// Longest first, so "बिरयानी" is tried before anything it begins with.
const ALIASES: { alias: string; english: string }[] = Object.entries(TERMS)
  .flatMap(([english, aliases]) => aliases.map((a) => ({ alias: normalise(a), english })))
  .sort((a, b) => b.alias.length - a.alias.length);

const COMBINING = /\p{M}/u;

/**
 * The message with each known dish or ride word in an Indian script replaced
 * by its English word. A word may carry a suffix ("బిర్యానీలు", "पिज्जा।"),
 * which goes with it, but the alias has to end where a syllable ends:
 * "వడ్డీ" (interest) begins with the letters of "వడ" and is not a vada.
 * Words in Latin script, and anything not listed, come back as they were.
 */
export function toEnglishTerms(message: string): string {
  return message
    .split(/(\s+)/)
    .map((token) => {
      if (!/[ऀ-ൿ]/.test(token)) return token;
      const word = normalise(token);
      if (NOT_TERMS.some((w) => word.startsWith(w))) return token;
      for (const { alias, english } of ALIASES) {
        if (!word.startsWith(alias)) continue;
        const next = word.slice(alias.length, alias.length + 1);
        if (next && COMBINING.test(next)) continue;
        return english;
      }
      return token;
    })
    .join("");
}
