import type { AgentAction, Target } from "./actions.js";

// Instructions in Hindi (Devanagari), Hinglish (Hindi in Latin letters) and
// Telugu, read into the same actions as English.
//
// These languages put the verb last ("isko cart mein daal do", put it in the
// cart), so English patterns do not fit and word for word translation
// misreads them. They get their own patterns here. One trap is worth naming:
// in Hinglish "do" is both "two" and the polite "please" ending ("daal do"),
// so a quantity is read only from digits or a number before "plate".
//
// Like the English reader, anything not recognised returns null and goes on
// to search or to the model, never to a guessed action.

const POSITION: [RegExp, number][] = [
  [/\b(pehla|pahla|pehle|pahle|first)\b|पहला|पहले|మొదటి/, 0],
  [/\b(doosra|dusra|doosre|dusre|second)\b|दूसरा|दूसरे|రెండో|రెండవ/, 1],
  [/\b(teesra|tisra|teesre|tisre|third)\b|तीसरा|तीसरे|మూడో|మూడవ/, 2],
  [/\b(chautha|chotha|chauthe|fourth)\b|चौथा|चौथे|నాలుగో|నాలుగవ/, 3],
];

const NUM: Record<string, number> = {
  ek: 1, "एक": 1, "ఒక": 1, "ఒకటి": 1,
  do: 2, "दो": 2, "రెండు": 2,
  teen: 3, "तीन": 3, "మూడు": 3,
  char: 4, chaar: 4, "चार": 4, "నాలుగు": 4,
  paanch: 5, panch: 5, "पांच": 5, "पाँच": 5, "ఐదు": 5,
  chhe: 6, "छह": 6, "ఆరు": 6,
};

function position(t: string): number | null {
  for (const [re, i] of POSITION) if (re.test(t)) return i;
  return null;
}

/** "2 plate", "do plate", "दो प्लेट", "రెండు ప్లేట్లు": a stated quantity. */
function quantity(t: string): number {
  const digits = t.match(/\b(\d{1,2})\b/);
  if (digits) return Math.min(20, Math.max(1, Number(digits[1])));
  const word = t.match(/(\S+)\s+(plate|plates|प्लेट|ప్లేట్)/);
  return word && NUM[word[1]!] ? NUM[word[1]!]! : 1;
}

function membersIn(t: string): number | null {
  const m = t.match(/(\d{1,2}|\S+)\s+(log|logon|logo|logon ka|logon ke|लोग|लोगों|लोगो|మంది|people)/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUM[m[1]!];
  return n && n >= 2 && n <= 50 ? n : null;
}

const YES = /^(haan|haa|ha|han|ji haan|ji ha|theek hai|thik hai|thik h|kar do|haan kar do|हाँ|हां|जी हाँ|जी हां|ठीक है|कर दो|అవును|సరే|ఓకే|చేయండి)( ji| please)?$/;
const NO = /^(nahi|nahin|nai|mat karo|rehne do|rahne do|nahi chahiye|नहीं|नही|मत करो|रहने दो|వద్దు|లేదు|వద్దండి)( ji)?$/;

const IT = /\b(isko|ise|iso|ye|yeh|yah|woh|wo|usko|use|vo)\b|इसको|इसे|यह|ये|वो|उसको|उसे|ఇది|అది|దాన్ని|దీన్ని/;
const ANOTHER = /\b(ek aur|aur ek|one more)\b|एक और|और एक|ఇంకొకటి|ఇంకో/;

export function parseIndic(text: string): AgentAction | null {
  const t = text.toLowerCase().replace(/[.!?,।]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;

  if (YES.test(t)) return { kind: "confirm" };
  if (NO.test(t)) return { kind: "cancel" };

  // Group order for N people, optionally with "only for me".
  if (/group|ग्रुप|గ్రూప్/.test(t) && /(banao|bana do|banaiye|shuru|create|बनाओ|बना दो|बनाइए|शुरू|చేయి|చేయండి|సృష్టించు|ప్రారంభించు|ఆర్డర్)/.test(t)) {
    const mine = /(sirf mere liye|bas mere liye|mere liye|सिर्फ़ मेरे लिए|सिर्फ मेरे लिए|मेरे लिए|నా కోసం మాత్రమే|నా కోసం)/.test(t);
    return { kind: "group.create", members: membersIn(t), withMyItems: mine };
  }

  // Rides for a group, and the answer to "shared or just yours".
  if (/(ride|cab|auto|राइड|कैब|ఆటో|క్యాబ్|రైడ్)/.test(t) && membersIn(t) && /(book|बुक|బుక్)/.test(t)) {
    return { kind: "ride.group", members: membersIn(t)! };
  }
  if (/^(sab saath|sab saath mein|ek saath|ek hi ride|सब साथ|एक साथ|एक ही राइड|అందరం కలిసి|ఒకే రైడ్)/.test(t)) {
    return { kind: "ride.group_mode", mode: "shared" };
  }
  if (/^(sirf meri ride|bas meri ride|meri ride|सिर्फ़ मेरी राइड|सिर्फ मेरी राइड|मेरी राइड|నా రైడ్ మాత్రమే|నా రైడ్)/.test(t)) {
    return { kind: "ride.group_mode", mode: "mine" };
  }

  const inCart = /(cart|basket|कार्ट|బాస్కెట్|కార్ట్)/.test(t);

  // Show, clear.
  if (inCart && /(dikhao|dikha do|dikhaiye|kya hai|दिखाओ|दिखा दो|दिखाइए|क्या है|చూపించు|చూపించండి|ఏముంది)/.test(t)) return { kind: "cart.show" };
  if (inCart && /(khali|khaali|saaf|clear|खाली|साफ़|साफ|ఖాళీ)/.test(t)) return { kind: "cart.clear" };

  // Book the chosen ride.
  if (/^(book kar do|book karo|book kijiye|बुक करो|बुक कर दो|बुक कीजिए|బుక్ చేయి|బుక్ చేయండి)$/.test(t)) return { kind: "ride.book" };

  // Choosing: "doosra wala", "sabse sasta", "रెండోది".
  if (/(sabse sasta|sabse saste|सबसे सस्ता|सबसे सस्ते|చౌకైనది|తక్కువ ధర)/.test(t)) return { kind: "select", index: null, pick: "cheapest" };
  if (/(sabse jaldi|sabse fast|सबसे जल्दी|త్వరగా వచ్చేది)/.test(t)) return { kind: "select", index: null, pick: "fastest" };

  const addVerb = /(daal|dal|daalo|dalo|add|rakh|rakho|le lo|lelo|chahiye|डालो|डाल दो|डालिए|जोड़ो|जोड़ दो|जोडो|रखो|ले लो|చేర్చు|చేర్చండి|వేయి|వేయండి|పెట్టు|పెట్టండి|కావాలి)/;
  const removeVerb = /(hatao|hata do|nikaal|nikal|remove|हटाओ|हटा दो|निकालो|निकाल दो|తీసేయి|తీసేయండి|తొలగించు)/;

  if (removeVerb.test(t) && !/(order|ऑर्डर|ఆర్డర్)/.test(t)) {
    const i = position(t);
    const target: Target = i !== null ? { by: "position", index: i } : { by: "last" };
    return { kind: "cart.remove", target };
  }
  if (addVerb.test(t) && (inCart || IT.test(t) || ANOTHER.test(t) || position(t) !== null || /plate|प्लेट|ప్లేట్/.test(t))) {
    const i = position(t);
    if (ANOTHER.test(t) && i === null) return { kind: "cart.add", target: { by: "last" }, qty: 1 };
    return { kind: "cart.add", target: i !== null ? { by: "position", index: i } : { by: "last" }, qty: quantity(t) };
  }
  // A bare choice with no verb: "doosra wala", "दूसरा वाला", "రెండోది".
  const bare = t.match(/^(\S+)\s*(wala|vala|waala|वाला|वाली)?$|^(రెండోది|మొదటిది|మూడోది|నాలుగోది)$/);
  if (bare && position(t) !== null) return { kind: "select", index: position(t)!, pick: null };

  return null;
}
