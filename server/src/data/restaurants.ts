// Simulated catalog standing in for live ONDC + platform data.
// Replaced by real adapters (same shape) when ONDC/affiliate access lands.

export type Platform = "ondc" | "swiggy" | "zomato";

export type Offer = {
  label: string;
  discountPaise: number;
};

export type Listing = {
  platform: Platform;
  basePaise: number;
  deliveryFeePaise: number;
  etaMinutes: number;
  offers: Offer[];
};

export type Dish = {
  id: string;
  name: string;
  restaurant: string;
  keywords: string[];
  dietary: "veg" | "nonveg";
  rating: number;
  ratingsCount?: number;
  tag: string; // badge shown in UI, e.g. "High Protein"
  reviewSummary: string;
  image?: string;
  listings: Listing[];
  /** How many people the portion feeds. Absent means one. Party-size items
   *  set this, and it is what makes a group suggestion checkable rather than
   *  a guess: a pack is only offered when it actually feeds the group. */
  serves?: number;
  /** What is in a party-size item, for the "Includes" list on the suggestion
   *  card. Display copy — the price is still the listing's. */
  includes?: string[];
  portion?: string[];
  addOns?: { name: string; pricePaise: number }[];
  bundleDiscountPaise?: number;
};

export const dishes: Dish[] = [
  {
    id: "dum-biryani",
    name: "Dum Biryani",
    restaurant: "Hotel Paradise",
    keywords: ["biryani", "rice", "hyderabadi"],
    dietary: "nonveg",
    rating: 4.5,
    ratingsCount: 2300,
    tag: "Best Seller",
    portion: ["500g", "Basmati Rice"],
    addOns: [{ name: "Raita", pricePaise: 3000 }, { name: "Mirchi Ka Salan", pricePaise: 4500 }],
    bundleDiscountPaise: 8000,
    reviewSummary:
      "Verified users praise the tender meat quality and the perfect spice balance. Best paired with Mirchi Ka Salan.",
    listings: [
      {
        platform: "ondc",
        basePaise: 24900,
        deliveryFeePaise: 1500,
        etaMinutes: 30,
        offers: [{ label: "Flouna launch offer", discountPaise: 3500 }],
      },
      {
        platform: "swiggy",
        basePaise: 26900,
        deliveryFeePaise: 2900,
        etaMinutes: 22,
        offers: [{ label: "New-user coupon DE***S", discountPaise: 3000 }],
      },
      {
        platform: "zomato",
        basePaise: 25900,
        deliveryFeePaise: 2400,
        etaMinutes: 20,
        offers: [{ label: "Delivery fee waived", discountPaise: 2400 }],
      },
    ],
  },
  {
    id: "quinoa-bowl",
    name: "Quinoa Avocado Bowl",
    restaurant: "Greenleaf Kitchen",
    keywords: ["quinoa", "salad", "healthy", "bowl"],
    dietary: "veg",
    rating: 4.6,
    ratingsCount: 890,
    tag: "High Protein",
    portion: ["350g", "Avocado, Quinoa"],
    reviewSummary:
      "Fresh ingredients and generous portions; reviewers call it the best healthy bowl nearby.",
    listings: [
      {
        platform: "ondc",
        basePaise: 17900,
        deliveryFeePaise: 1200,
        etaMinutes: 28,
        offers: [],
      },
      {
        platform: "swiggy",
        basePaise: 19000,
        deliveryFeePaise: 2500,
        etaMinutes: 20,
        offers: [{ label: "Healthy week 10% off", discountPaise: 1900 }],
      },
    ],
  },
  {
    id: "mushroom-pasta",
    name: "Creamy Mushroom Pasta",
    restaurant: "Olive Bistro",
    keywords: ["pasta", "italian", "mushroom"],
    dietary: "veg",
    rating: 4.3,
    tag: "Quick & Easy",
    reviewSummary:
      "Rich sauce, arrives hot; a few mention portions run small for sharing.",
    listings: [
      {
        platform: "swiggy",
        basePaise: 19900,
        deliveryFeePaise: 2000,
        etaMinutes: 15,
        offers: [{ label: "Flat ₹30 off", discountPaise: 3000 }],
      },
      {
        platform: "zomato",
        basePaise: 20900,
        deliveryFeePaise: 1800,
        etaMinutes: 18,
        offers: [],
      },
    ],
  },
  {
    id: "masala-dosa",
    name: "Masala Dosa",
    restaurant: "Udupi Grand",
    keywords: ["dosa", "south indian", "breakfast", "idli"],
    dietary: "veg",
    rating: 4.4,
    tag: "South Indian",
    reviewSummary:
      "Crisp dosa and authentic chutneys; consistently rated the best value breakfast in the area.",
    listings: [
      {
        platform: "ondc",
        basePaise: 12900,
        deliveryFeePaise: 1000,
        etaMinutes: 25,
        offers: [{ label: "Morning offer", discountPaise: 1000 }],
      },
      {
        platform: "swiggy",
        basePaise: 14900,
        deliveryFeePaise: 2200,
        etaMinutes: 18,
        offers: [],
      },
      {
        platform: "zomato",
        basePaise: 13900,
        deliveryFeePaise: 2000,
        etaMinutes: 21,
        offers: [{ label: "Gold member offer", discountPaise: 1400 }],
      },
    ],
  },
  {
    id: "margherita-pizza",
    name: "Margherita Pizza",
    restaurant: "Brick Oven Co.",
    keywords: ["pizza", "italian", "cheese"],
    dietary: "veg",
    rating: 4.2,
    tag: "Popular",
    reviewSummary:
      "Wood-fired crust gets high marks; delivery can slow down at peak dinner hours.",
    listings: [
      {
        platform: "swiggy",
        basePaise: 29900,
        deliveryFeePaise: 2500,
        etaMinutes: 25,
        offers: [{ label: "BOGO Tuesday", discountPaise: 6000 }],
      },
      {
        platform: "zomato",
        basePaise: 28900,
        deliveryFeePaise: 3000,
        etaMinutes: 28,
        offers: [{ label: "Bank offer (ICICI)", discountPaise: 4000 }],
      },
      {
        platform: "ondc",
        basePaise: 27900,
        deliveryFeePaise: 1800,
        etaMinutes: 35,
        offers: [],
      },
    ],
  },
  {
    id: "chicken-burger",
    name: "Crispy Chicken Burger",
    restaurant: "Stacked",
    keywords: ["burger", "chicken", "fast food"],
    dietary: "nonveg",
    rating: 4.1,
    tag: "Crowd Favourite",
    reviewSummary:
      "Juicy patty and fast delivery; fries portion could be bigger.",
    listings: [
      {
        platform: "swiggy",
        basePaise: 17900,
        deliveryFeePaise: 1900,
        etaMinutes: 16,
        offers: [{ label: "Combo saver", discountPaise: 2500 }],
      },
      {
        platform: "ondc",
        basePaise: 16500,
        deliveryFeePaise: 1400,
        etaMinutes: 24,
        offers: [],
      },
    ],
  },
  {
    id: "veg-thali",
    name: "Special Veg Thali",
    restaurant: "Annapurna Bhavan",
    keywords: ["thali", "meals", "lunch", "north indian"],
    dietary: "veg",
    rating: 4.5,
    tag: "Homestyle",
    reviewSummary:
      "Homestyle taste with rotating sabzis; great value, slightly longer delivery.",
    listings: [
      {
        platform: "ondc",
        basePaise: 15900,
        deliveryFeePaise: 900,
        etaMinutes: 32,
        offers: [{ label: "Lunch hour deal", discountPaise: 2000 }],
      },
      {
        platform: "zomato",
        basePaise: 17900,
        deliveryFeePaise: 2100,
        etaMinutes: 24,
        offers: [],
      },
    ],
  },
  {
    id: "paneer-roll",
    name: "Paneer Tikka Roll",
    restaurant: "Roll Junction",
    keywords: ["roll", "paneer", "wrap", "snack"],
    dietary: "veg",
    rating: 4.0,
    tag: "Quick Bite",
    reviewSummary:
      "Smoky paneer and soft rumali; reviewers love it as an evening snack.",
    listings: [
      {
        platform: "swiggy",
        basePaise: 13900,
        deliveryFeePaise: 1700,
        etaMinutes: 14,
        offers: [{ label: "Snack time ₹20 off", discountPaise: 2000 }],
      },
      {
        platform: "zomato",
        basePaise: 14500,
        deliveryFeePaise: 1500,
        etaMinutes: 17,
        offers: [],
      },
    ],
  },
  {
    id: "chocolate-cake",
    name: "Molten Chocolate Cake",
    restaurant: "Sugar & Spice",
    keywords: ["cake", "dessert", "chocolate", "ice cream"],
    dietary: "veg",
    rating: 4.7,
    ratingsCount: 1450,
    tag: "Top Rated",
    portion: ["180g"],
    reviewSummary:
      "Gooey centre every single time, the highest-rated dessert near you.",
    listings: [
      {
        platform: "zomato",
        basePaise: 9900,
        deliveryFeePaise: 1800,
        etaMinutes: 19,
        offers: [{ label: "Dessert fest 15% off", discountPaise: 1485 }],
      },
      {
        platform: "swiggy",
        basePaise: 10500,
        deliveryFeePaise: 2000,
        etaMinutes: 21,
        offers: [],
      },
    ],
  },
  {
    id: "steamed-momos",
    name: "Steamed Chicken Momos",
    restaurant: "Himalayan Bites",
    keywords: ["momos", "chinese", "tibetan", "snack"],
    dietary: "nonveg",
    rating: 4.3,
    tag: "Street Style",
    reviewSummary:
      "Juicy filling and fiery chutney; consistently quick deliveries.",
    listings: [
      {
        platform: "swiggy",
        basePaise: 11900,
        deliveryFeePaise: 1600,
        etaMinutes: 13,
        offers: [{ label: "Flat ₹15 off", discountPaise: 1500 }],
      },
      {
        platform: "ondc",
        basePaise: 10900,
        deliveryFeePaise: 1200,
        etaMinutes: 22,
        offers: [],
      },
    ],
  },

  // ---------- party sizes ----------
  //
  // Priced below the sum of the equivalent single portions, which is the whole
  // reason a group would switch to one. The saving is the restaurant's, not a
  // discount Flouna invents at checkout.
  {
    id: "family-biryani-pack",
    name: "Family Biryani Pack",
    restaurant: "Hotel Paradise",
    keywords: ["biryani", "rice", "hyderabadi", "pack", "family"],
    dietary: "nonveg",
    rating: 4.6,
    tag: "Serves 3-4",
    reviewSummary:
      "The pack most groups end up ordering: enough biryani for four, with raita and a dessert included.",
    serves: 4,
    includes: ["2 x Chicken Biryani", "1 x Mutton Biryani", "2 x Raita", "1 x Dessert"],
    listings: [
      {
        platform: "ondc",
        basePaise: 76500,
        deliveryFeePaise: 1500,
        etaMinutes: 35,
        offers: [],
      },
      {
        platform: "swiggy",
        basePaise: 82900,
        deliveryFeePaise: 2900,
        etaMinutes: 30,
        offers: [],
      },
      {
        platform: "zomato",
        basePaise: 80900,
        deliveryFeePaise: 2400,
        etaMinutes: 32,
        offers: [],
      },
    ],
  },
  {
    id: "dosa-party-platter",
    name: "Dosa Party Platter",
    restaurant: "Udupi Grand",
    keywords: ["dosa", "south indian", "pack", "family", "platter"],
    dietary: "veg",
    rating: 4.5,
    tag: "Serves 3-4",
    reviewSummary:
      "Four dosas with sambar, three chutneys and a pot of filter coffee. Built for a table, not a person.",
    serves: 4,
    includes: ["4 x Masala Dosa", "Sambar and 3 chutneys", "1 x Filter Coffee pot"],
    listings: [
      {
        platform: "ondc",
        basePaise: 42000,
        deliveryFeePaise: 1000,
        etaMinutes: 28,
        offers: [],
      },
      {
        platform: "swiggy",
        basePaise: 46900,
        deliveryFeePaise: 2500,
        etaMinutes: 24,
        offers: [],
      },
      {
        platform: "zomato",
        basePaise: 45900,
        deliveryFeePaise: 2200,
        etaMinutes: 26,
        offers: [],
      },
    ],
  },
  {
    id: "pizza-party-box",
    name: "Pizza Party Box",
    restaurant: "Napoli Corner",
    keywords: ["pizza", "italian", "pack", "family", "party"],
    dietary: "veg",
    rating: 4.4,
    tag: "Serves 3-4",
    reviewSummary:
      "Two large pizzas, garlic bread and a bottle of cola. Cheaper than four people ordering their own.",
    serves: 4,
    includes: ["2 x Large Margherita", "1 x Garlic Bread", "1 x Cola 750ml"],
    listings: [
      {
        platform: "ondc",
        basePaise: 70000,
        deliveryFeePaise: 1500,
        etaMinutes: 30,
        offers: [],
      },
      {
        platform: "swiggy",
        basePaise: 76900,
        deliveryFeePaise: 2900,
        etaMinutes: 26,
        offers: [],
      },
      {
        platform: "zomato",
        basePaise: 74900,
        deliveryFeePaise: 2400,
        etaMinutes: 28,
        offers: [],
      },
    ],
  },
];

