// Category defaults and safety bounds for shelf life, in days per storage state.
// `max: null` means there is no upper bound (the state has no meaningful expiry).
// Values are conservative household guidance in the spirit of USDA FoodKeeper;
// they are fallbacks and clamps, not facts about any particular package.

export const FOOD_STATES = ['sealed', 'opened', 'frozen', 'thawed', 'prepared'] as const;
export type FoodState = (typeof FOOD_STATES)[number];

export type Perishability = 'shelf_stable' | 'perishable';

export interface ShelfLifeBound {
  /** Default estimate when nothing better is known. `null` = no meaningful expiry. */
  days: number | null;
  /** Safety bound: estimates above this are clamped. `null` = unbounded. */
  max: number | null;
}

export interface CategoryDefaults {
  label: string;
  perishability: Perishability;
  states: Record<FoodState, ShelfLifeBound>;
  /** Lowercase keywords used by the deterministic classifier (longest match wins). */
  keywords: readonly string[];
}

const b = (days: number | null, max: number | null): ShelfLifeBound => ({ days, max });

export const SHELF_LIFE_DEFAULTS = {
  dairy: {
    label: 'Milk, yogurt, cream, butter',
    perishability: 'perishable',
    states: { sealed: b(10, 21), opened: b(7, 10), frozen: b(90, 180), thawed: b(3, 5), prepared: b(3, 4) },
    keywords: ['milk', 'whole milk', 'skim milk', 'yogurt', 'greek yogurt', 'cream', 'heavy cream', 'half and half', 'sour cream', 'butter', 'kefir', 'cottage cheese', 'oat milk', 'almond milk'],
  },
  cheese: {
    label: 'Cheese',
    perishability: 'perishable',
    states: { sealed: b(30, 180), opened: b(21, 42), frozen: b(120, 240), thawed: b(7, 14), prepared: b(3, 4) },
    keywords: ['cheese', 'cheddar', 'parmesan', 'mozzarella', 'feta', 'brie', 'gouda', 'swiss', 'ricotta', 'provolone'],
  },
  eggs: {
    label: 'Eggs',
    perishability: 'perishable',
    states: { sealed: b(28, 42), opened: b(2, 4), frozen: b(180, 365), thawed: b(1, 2), prepared: b(5, 7) },
    keywords: ['egg', 'eggs', 'egg whites'],
  },
  poultry: {
    label: 'Raw chicken, turkey and other poultry',
    perishability: 'perishable',
    states: { sealed: b(2, 3), opened: b(1, 2), frozen: b(270, 365), thawed: b(1, 2), prepared: b(3, 4) },
    keywords: ['chicken', 'chicken breast', 'chicken thighs', 'turkey', 'duck', 'wings', 'drumsticks', 'rotisserie chicken'],
  },
  meat: {
    label: 'Raw beef, pork and lamb cuts',
    perishability: 'perishable',
    states: { sealed: b(3, 5), opened: b(2, 3), frozen: b(180, 365), thawed: b(2, 3), prepared: b(3, 4) },
    keywords: ['beef', 'steak', 'pork', 'pork chops', 'lamb', 'roast', 'ribs', 'brisket', 'tenderloin', 'bacon'],
  },
  ground_meat: {
    label: 'Ground meat and fresh sausage',
    perishability: 'perishable',
    states: { sealed: b(2, 2), opened: b(1, 2), frozen: b(120, 180), thawed: b(1, 2), prepared: b(3, 4) },
    keywords: ['ground beef', 'ground turkey', 'ground pork', 'ground chicken', 'sausage', 'mince', 'burger patties'],
  },
  seafood: {
    label: 'Fresh fish and shellfish',
    perishability: 'perishable',
    states: { sealed: b(2, 2), opened: b(1, 2), frozen: b(180, 270), thawed: b(1, 2), prepared: b(3, 4) },
    keywords: ['salmon', 'shrimp', 'fish', 'cod', 'tilapia', 'scallops', 'crab', 'tuna steak', 'mussels'],
  },
  deli_meat: {
    label: 'Deli, cured and processed meats (sliced turkey, ham, salami, hot dogs)',
    perishability: 'perishable',
    states: { sealed: b(14, 14), opened: b(4, 5), frozen: b(60, 60), thawed: b(3, 5), prepared: b(3, 4) },
    keywords: ['ham', 'salami', 'deli', 'deli turkey', 'prosciutto', 'pepperoni', 'hot dogs', 'bologna'],
  },
  plant_protein: {
    label: 'Tofu, tempeh and similar',
    perishability: 'perishable',
    states: { sealed: b(30, 90), opened: b(4, 5), frozen: b(150, 180), thawed: b(3, 5), prepared: b(4, 5) },
    keywords: ['tofu', 'tempeh', 'seitan', 'hummus'],
  },
  leafy_greens: {
    label: 'Leafy greens and salad',
    perishability: 'perishable',
    states: { sealed: b(5, 7), opened: b(3, 5), frozen: b(240, 365), thawed: b(1, 2), prepared: b(2, 3) },
    keywords: ['spinach', 'baby spinach', 'lettuce', 'romaine', 'kale', 'arugula', 'greens', 'salad', 'salad mix', 'spring mix', 'chard', 'cabbage'],
  },
  berries: {
    label: 'Berries',
    perishability: 'perishable',
    states: { sealed: b(4, 7), opened: b(3, 5), frozen: b(240, 365), thawed: b(1, 2), prepared: b(2, 3) },
    keywords: ['strawberries', 'strawberry', 'blueberries', 'raspberries', 'blackberries', 'berries', 'cherries'],
  },
  fruit: {
    label: 'Other fresh fruit',
    perishability: 'perishable',
    states: { sealed: b(7, 30), opened: b(3, 5), frozen: b(240, 365), thawed: b(1, 2), prepared: b(3, 4) },
    keywords: ['banana', 'bananas', 'apple', 'apples', 'orange', 'oranges', 'grapes', 'lemon', 'lemons', 'lime', 'limes', 'avocado', 'avocados', 'pear', 'pears', 'peach', 'peaches', 'mango', 'melon', 'watermelon', 'pineapple', 'kiwi', 'plums'],
  },
  vegetables: {
    label: 'Fresh vegetables',
    perishability: 'perishable',
    states: { sealed: b(7, 14), opened: b(4, 5), frozen: b(240, 365), thawed: b(1, 2), prepared: b(3, 5) },
    keywords: ['tomato', 'tomatoes', 'cherry tomatoes', 'pepper', 'peppers', 'bell pepper', 'broccoli', 'cucumber', 'zucchini', 'mushrooms', 'cauliflower', 'celery', 'green beans', 'asparagus', 'corn', 'eggplant', 'brussels sprouts', 'snap peas', 'squash'],
  },
  root_vegetables: {
    label: 'Potatoes, onions, carrots and other roots',
    perishability: 'perishable',
    states: { sealed: b(21, 60), opened: b(5, 14), frozen: b(240, 365), thawed: b(2, 3), prepared: b(3, 5) },
    keywords: ['potato', 'potatoes', 'sweet potato', 'sweet potatoes', 'onion', 'onions', 'carrot', 'carrots', 'garlic', 'beets', 'shallots', 'ginger', 'parsnips', 'radishes'],
  },
  herbs: {
    label: 'Fresh herbs',
    perishability: 'perishable',
    states: { sealed: b(7, 14), opened: b(5, 7), frozen: b(120, 180), thawed: b(1, 2), prepared: b(2, 3) },
    keywords: ['basil', 'cilantro', 'parsley', 'mint', 'dill', 'thyme', 'rosemary', 'chives', 'scallions', 'green onions'],
  },
  bread: {
    label: 'Bread and bakery',
    perishability: 'perishable',
    states: { sealed: b(5, 14), opened: b(5, 7), frozen: b(90, 180), thawed: b(3, 5), prepared: b(3, 5) },
    keywords: ['bread', 'bagel', 'bagels', 'tortilla', 'tortillas', 'buns', 'baguette', 'pita', 'english muffins', 'croissant', 'naan', 'sourdough'],
  },
  grains_pasta: {
    label: 'Dry pasta, rice, grains and cereal',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(null, null), frozen: b(180, 365), thawed: b(30, 60), prepared: b(4, 5) },
    keywords: ['pasta', 'spaghetti', 'penne', 'macaroni', 'rice', 'brown rice', 'oats', 'oatmeal', 'cereal', 'quinoa', 'noodles', 'couscous', 'lentils', 'dried beans'],
  },
  canned_goods: {
    label: 'Canned and jarred goods (beans, tomatoes, tuna, broth, coconut milk)',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(4, 7), frozen: b(60, 90), thawed: b(3, 4), prepared: b(3, 4) },
    keywords: ['canned', 'can', 'chickpeas', 'black beans', 'kidney beans', 'canned tomatoes', 'tomato paste', 'canned tuna', 'soup', 'broth', 'stock', 'coconut milk'],
  },
  sauces: {
    label: 'Pasta sauce, salsa, pesto and fresh sauces',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(5, 10), frozen: b(90, 180), thawed: b(3, 5), prepared: b(3, 5) },
    keywords: ['pasta sauce', 'marinara', 'salsa', 'pesto', 'tomato sauce', 'alfredo', 'curry paste', 'enchilada sauce'],
  },
  condiments: {
    label: 'Condiments, spreads and dressings',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(60, 365), frozen: b(null, null), thawed: b(30, 60), prepared: b(7, 14) },
    keywords: ['ketchup', 'mustard', 'mayo', 'mayonnaise', 'soy sauce', 'hot sauce', 'jam', 'jelly', 'peanut butter', 'dressing', 'relish', 'bbq sauce', 'maple syrup', 'sriracha', 'vinegar', 'pickles'],
  },
  dry_goods: {
    label: 'Baking staples, oils and spices',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(365, 730), frozen: b(365, 730), thawed: b(90, 180), prepared: b(4, 5) },
    keywords: ['flour', 'sugar', 'brown sugar', 'salt', 'spice', 'spices', 'olive oil', 'oil', 'vegetable oil', 'honey', 'baking soda', 'baking powder', 'vanilla', 'cocoa', 'yeast', 'cornstarch'],
  },
  snacks: {
    label: 'Chips, crackers, nuts and packaged snacks',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(30, 90), frozen: b(90, 180), thawed: b(7, 14), prepared: b(7, 14) },
    keywords: ['chips', 'crackers', 'cookies', 'nuts', 'almonds', 'pretzels', 'popcorn', 'granola', 'granola bars', 'trail mix', 'chocolate'],
  },
  beverages: {
    label: 'Juice, soda, coffee and other drinks',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(7, 10), frozen: b(240, 365), thawed: b(3, 7), prepared: b(3, 5) },
    keywords: ['juice', 'orange juice', 'soda', 'coffee', 'tea', 'water', 'sparkling water', 'seltzer', 'beer', 'wine', 'kombucha', 'sports drink'],
  },
  frozen_foods: {
    label: 'Foods bought frozen',
    perishability: 'perishable',
    states: { sealed: b(180, 365), opened: b(90, 180), frozen: b(180, 365), thawed: b(1, 2), prepared: b(3, 4) },
    keywords: ['frozen', 'ice cream', 'frozen pizza', 'frozen peas', 'frozen vegetables', 'frozen fruit', 'popsicles', 'frozen dinner'],
  },
  leftovers: {
    label: 'Cooked leftovers and prepared dishes',
    perishability: 'perishable',
    states: { sealed: b(3, 4), opened: b(3, 4), frozen: b(90, 120), thawed: b(2, 3), prepared: b(3, 4) },
    keywords: ['leftover', 'leftovers', 'cooked', 'casserole', 'stir fry', 'chili', 'curry', 'lasagna', 'meal prep'],
  },
  other: {
    label: 'Anything else (conservative perishable defaults)',
    perishability: 'perishable',
    states: { sealed: b(7, 14), opened: b(3, 7), frozen: b(90, 180), thawed: b(2, 3), prepared: b(3, 4) },
    keywords: [],
  },
  non_food: {
    label: 'Not food: household goods, pet food, fees and deposits',
    perishability: 'shelf_stable',
    states: { sealed: b(null, null), opened: b(null, null), frozen: b(null, null), thawed: b(null, null), prepared: b(null, null) },
    keywords: ['paper towels', 'paper towel', 'toilet paper', 'detergent', 'laundry', 'soap', 'dish soap', 'trash bags', 'foil', 'aluminum foil', 'plastic wrap', 'batteries', 'napkins', 'sponge', 'sponges', 'shampoo', 'tissues', 'bleach', 'cleaner'],
  },
} as const satisfies Record<string, CategoryDefaults>;

export type FoodCategory = keyof typeof SHELF_LIFE_DEFAULTS;

export const FOOD_CATEGORIES = Object.keys(SHELF_LIFE_DEFAULTS) as [FoodCategory, ...FoodCategory[]];

export function isFoodCategory(value: unknown): value is FoodCategory {
  return typeof value === 'string' && Object.hasOwn(SHELF_LIFE_DEFAULTS, value);
}

export function categoryDefaults(category: string | undefined): CategoryDefaults {
  return isFoodCategory(category) ? SHELF_LIFE_DEFAULTS[category] : SHELF_LIFE_DEFAULTS.other;
}
