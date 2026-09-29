// Synthetic food catalog for the canonicalizeItems eval. Ground truth is authored here by hand;
// receipt lines are rendered from it, so labels are correct by construction.
//
// Each food lists receipt-style name variants. Variants are split between dev and test by index
// (even → dev, odd → test) so test strings never appear in dev.

import type { FoodCategory } from '../../src/shelfLifeDefaults.ts';

export interface PackageSpec {
  /** How the size is printed, e.g. "2X32 OZ". `{S}` in a variant is replaced with this. */
  text: string;
  count?: number;
  size: number;
  unit: string;
}

export interface CatalogFood {
  key: string;
  name: string;
  /** Other acceptable canonical names. */
  accept?: string[];
  category: FoodCategory;
  /** Other acceptable categories when the boundary is genuinely fuzzy. */
  acceptCategories?: FoodCategory[];
  variants: string[];
  packages: PackageSpec[];
  /** Keys of foods that look similar but are different foods (must not match). */
  lookalikes?: string[];
  /** Keys of foods that a household may reasonably treat as the same food. */
  sameAs?: string[];
  /** Sold loose by weight (package optional). */
  byWeight?: boolean;
}

const p = (text: string, size: number, unit: string, count?: number): PackageSpec => ({ text, size, unit, ...(count ? { count } : {}) });

const GAL = [p('1 GAL', 1, 'gal'), p('1/2 GAL', 0.5, 'gal'), p('HALF GAL', 0.5, 'gal'), p('64 FL OZ', 64, 'fl_oz')];
const OZ = (...sizes: number[]) => sizes.flatMap((s) => [p(`${s} OZ`, s, 'oz'), p(`${s}OZ`, s, 'oz')]);
const LB = (...sizes: number[]) => sizes.flatMap((s) => [p(`${s} LB`, s, 'lb'), p(`${s}LB`, s, 'lb')]);
const CT = (...counts: number[]) => counts.map((c) => p(`${c} CT`, c, 'ct'));

export const FOODS: CatalogFood[] = [
  // dairy
  { key: 'whole_milk', name: 'whole milk', accept: ['vitamin d milk'], category: 'dairy', variants: ['WHOLE MILK {S}', 'MILK WHOLE {S}', 'WHL MILK {S}', 'VIT D MILK {S}', 'WHOLE MLK {S}', 'MILK VITAMIN D {S}'], packages: GAL, lookalikes: ['milk_2pct', 'skim_milk', 'oat_milk'] },
  { key: 'milk_2pct', name: '2% milk', accept: ['reduced fat milk', 'milk 2%', '2 percent milk'], category: 'dairy', variants: ['2% MILK {S}', 'MILK 2% {S}', 'RED FAT MILK {S}', '2% RF MILK {S}', 'REDUCED FAT 2% {S}', 'MLK 2PCT {S}'], packages: GAL, lookalikes: ['whole_milk', 'skim_milk'] },
  { key: 'skim_milk', name: 'skim milk', accept: ['fat free milk', 'nonfat milk'], category: 'dairy', variants: ['SKIM MILK {S}', 'FAT FREE MILK {S}', 'NONFAT MILK {S}', 'SKIM MLK {S}', 'FF MILK {S}', 'MILK SKIM {S}'], packages: GAL, lookalikes: ['whole_milk', 'milk_2pct'] },
  { key: 'oat_milk', name: 'oat milk', accept: ['oat beverage'], category: 'dairy', acceptCategories: ['beverages'], variants: ['OAT MILK {S}', 'OATMILK ORIG {S}', 'OAT BEV {S}', 'OAT MLK {S}', 'OATLY OAT MILK {S}', 'OAT MILK BARISTA {S}'], packages: [p('64 FL OZ', 64, 'fl_oz'), p('32 OZ', 32, 'oz'), p('1/2 GAL', 0.5, 'gal')], lookalikes: ['whole_milk', 'almond_milk'] },
  { key: 'almond_milk', name: 'almond milk', category: 'dairy', acceptCategories: ['beverages'], variants: ['ALMOND MILK {S}', 'ALMONDMILK UNSWT {S}', 'ALM MILK {S}', 'ALMOND BEV {S}', 'UNSWT ALMOND {S}', 'ALMND MLK {S}'], packages: [p('64 FL OZ', 64, 'fl_oz'), p('1/2 GAL', 0.5, 'gal')], lookalikes: ['oat_milk'] },
  { key: 'greek_yogurt', name: 'greek yogurt', accept: ['plain greek yogurt', 'nonfat greek yogurt'], category: 'dairy', variants: ['GRK YOGURT {S}', 'GREEK YOGURT {S}', 'GRK YOG PLAIN {S}', 'GREEK YGRT {S}', 'NF GREEK YOGURT {S}', 'YOGURT GREEK PLN {S}'], packages: [p('2X32 OZ', 32, 'oz', 2), p('32 OZ', 32, 'oz'), p('4X5.3 OZ', 5.3, 'oz', 4), p('5.3OZ', 5.3, 'oz')], lookalikes: ['vanilla_yogurt'] },
  { key: 'vanilla_yogurt', name: 'vanilla yogurt', category: 'dairy', variants: ['VANILLA YOGURT {S}', 'YOG VAN {S}', 'VAN YOGURT {S}', 'YOGURT VANILLA {S}', 'LF VAN YOG {S}', 'VNL YOGURT {S}'], packages: [p('32 OZ', 32, 'oz'), p('6X6 OZ', 6, 'oz', 6)], lookalikes: ['greek_yogurt'] },
  { key: 'butter', name: 'butter', accept: ['unsalted butter', 'salted butter'], category: 'dairy', variants: ['BUTTER UNSALTED {S}', 'SWEET CRM BUTTER {S}', 'BUTTER SALTED {S}', 'UNSLTD BUTTER {S}', 'BUTTER QTRS {S}', 'BTR SALTED {S}'], packages: [p('4X4 OZ', 4, 'oz', 4), p('1 LB', 1, 'lb'), p('16 OZ', 16, 'oz')] },
  { key: 'heavy_cream', name: 'heavy cream', accept: ['heavy whipping cream', 'whipping cream'], category: 'dairy', variants: ['HEAVY CREAM {S}', 'HVY WHIP CREAM {S}', 'HEAVY WHPG CRM {S}', 'CREAM HEAVY {S}', 'HVY CREAM {S}', 'WHIPPING CREAM HVY {S}'], packages: [p('1 QT', 1, 'qt'), p('1 PT', 1, 'pt'), p('32 FL OZ', 32, 'fl_oz')], lookalikes: ['half_and_half'] },
  { key: 'half_and_half', name: 'half and half', accept: ['half & half'], category: 'dairy', variants: ['HALF & HALF {S}', 'HALF AND HALF {S}', 'HALF/HALF {S}', 'H&H CREAMER {S}', 'HLF HLF {S}', 'HALF N HALF {S}'], packages: [p('1 QT', 1, 'qt'), p('1 PT', 1, 'pt')], lookalikes: ['heavy_cream'] },
  { key: 'sour_cream', name: 'sour cream', category: 'dairy', variants: ['SOUR CREAM {S}', 'SR CREAM {S}', 'SOUR CRM {S}', 'CREAM SOUR {S}', 'LT SOUR CREAM {S}', 'SOUR CREAM ORIG {S}'], packages: OZ(16, 24) },
  { key: 'cottage_cheese', name: 'cottage cheese', category: 'dairy', acceptCategories: ['cheese'], variants: ['COTTAGE CHEESE {S}', 'COTTAGE CHS {S}', 'CTG CHEESE 4% {S}', 'LF COTTAGE CHEESE {S}', 'COTT CHEESE {S}', 'CHEESE COTTAGE {S}'], packages: OZ(16, 24) },
  // cheese
  { key: 'cheddar', name: 'cheddar cheese', accept: ['shredded cheddar', 'sharp cheddar', 'cheddar'], category: 'cheese', variants: ['SHRD CHEDDAR {S}', 'SHARP CHEDDAR {S}', 'CHDR SHRD {S}', 'CHEDDAR CHS BLK {S}', 'MILD CHEDDAR SHRD {S}', 'CHEESE CHEDDAR {S}'], packages: [...OZ(8, 16), p('2 LB', 2, 'lb'), p('2.5 LB', 2.5, 'lb')], lookalikes: ['mozzarella', 'mexican_blend'] },
  { key: 'mozzarella', name: 'mozzarella cheese', accept: ['shredded mozzarella', 'mozzarella', 'fresh mozzarella'], category: 'cheese', variants: ['SHRD MOZZ {S}', 'MOZZARELLA {S}', 'LM MOZZ SHRD {S}', 'MOZZ CHEESE {S}', 'FRESH MOZZ {S}', 'CHEESE MOZZARELLA {S}'], packages: [...OZ(8, 16), p('2 LB', 2, 'lb')], lookalikes: ['cheddar'] },
  { key: 'parmesan', name: 'parmesan cheese', accept: ['parmesan', 'parmigiano reggiano', 'grated parmesan'], category: 'cheese', variants: ['PARMESAN {S}', 'PARM REGG {S}', 'GRATED PARM {S}', 'PARMIGIANO {S}', 'PARM WEDGE {S}', 'SHRD PARMESAN {S}'], packages: OZ(5, 8, 24) },
  { key: 'mexican_blend', name: 'mexican blend cheese', accept: ['shredded mexican blend', 'mexican cheese blend', 'mexican style cheese'], category: 'cheese', variants: ['MEX BLEND SHRD {S}', 'MEXICAN BLEND {S}', 'MEX 4 CHEESE {S}', 'FIESTA BLEND SHRD {S}', 'MEX STYLE SHRD {S}', 'SHRD MEX BLND {S}'], packages: [...OZ(8, 16), p('2.5 LB', 2.5, 'lb')], lookalikes: ['cheddar'] },
  { key: 'feta', name: 'feta cheese', accept: ['feta', 'crumbled feta'], category: 'cheese', variants: ['FETA CRMBL {S}', 'FETA CHEESE {S}', 'CRUMBLED FETA {S}', 'FETA CRUMBLES {S}', 'GRK FETA {S}', 'CHEESE FETA {S}'], packages: OZ(4, 6, 12) },
  { key: 'cream_cheese', name: 'cream cheese', category: 'cheese', acceptCategories: ['dairy'], variants: ['CREAM CHEESE {S}', 'CRM CHEESE {S}', 'CREAM CHS BAR {S}', 'CRM CHS SPRD {S}', 'CREAM CHEESE BRICK {S}', 'CHEESE CREAM {S}'], packages: OZ(8), lookalikes: ['sour_cream'] },
  // eggs
  { key: 'eggs', name: 'eggs', accept: ['large eggs', 'brown eggs', 'egg'], category: 'eggs', variants: ['EGGS LG {S}', 'LARGE EGGS {S}', 'EGGS {S}', 'LG BRN EGGS {S}', 'CAGE FREE EGGS {S}', 'GR A LG EGGS {S}'], packages: [...CT(12, 18, 24), p('5 DZ', 60, 'ct'), p('2 DZ', 24, 'ct')], lookalikes: ['egg_whites'] },
  { key: 'egg_whites', name: 'egg whites', accept: ['liquid egg whites'], category: 'eggs', variants: ['EGG WHITES {S}', 'LIQ EGG WHT {S}', '100% EGG WHITES {S}', 'EGG WHT LIQUID {S}', 'EGG BEATERS WHT {S}', 'WHITES EGG {S}'], packages: [p('32 OZ', 32, 'oz'), p('16 OZ', 16, 'oz'), p('3X16 OZ', 16, 'oz', 3)], lookalikes: ['eggs'] },
  // poultry
  { key: 'chicken_breast', name: 'chicken breast', accept: ['chicken breasts', 'boneless skinless chicken breast'], category: 'poultry', variants: ['CHKN BREAST {S}', 'BNLS SKNLS BREAST {S}', 'CHICKEN BRST {S}', 'BS CHKN BRST {S}', 'CHICKEN BREAST {S}', 'CHK BRST BNLS {S}'], packages: [...LB(1.5, 3, 6.5)], lookalikes: ['chicken_thighs', 'ground_chicken', 'rotisserie_chicken'] },
  { key: 'chicken_thighs', name: 'chicken thighs', accept: ['chicken thigh', 'boneless chicken thighs'], category: 'poultry', variants: ['CHKN THIGHS {S}', 'BNLS THIGH {S}', 'CHICKEN THGH {S}', 'BS CHKN THIGH {S}', 'THIGHS CHICKEN {S}', 'CHK THGH BNLS {S}'], packages: [...LB(1.5, 4)], lookalikes: ['chicken_breast', 'chicken_wings'] },
  { key: 'chicken_wings', name: 'chicken wings', accept: ['wings'], category: 'poultry', variants: ['CHKN WINGS {S}', 'WING SECTIONS {S}', 'CHICKEN WINGS {S}', 'PARTY WINGS {S}', 'WINGS CHKN {S}', 'CHK WING DRMS {S}'], packages: [...LB(2, 5)], lookalikes: ['chicken_thighs'] },
  { key: 'ground_chicken', name: 'ground chicken', category: 'ground_meat', acceptCategories: ['poultry'], variants: ['GRND CHICKEN {S}', 'GROUND CHKN {S}', 'CHICKEN GRND {S}', 'GR CHICKEN {S}', 'GROUND CHICKEN {S}', 'CHK GRND {S}'], packages: [...LB(1, 3)], lookalikes: ['chicken_breast', 'ground_turkey'] },
  { key: 'rotisserie_chicken', name: 'rotisserie chicken', category: 'poultry', acceptCategories: ['leftovers'], variants: ['ROTISSERIE CHKN', 'ROTIS CHICKEN', 'ROT CHICKEN', 'CHICKEN ROTISSERIE', 'ROTISS CHKN', 'HOT ROTIS CHKN'], packages: [], lookalikes: ['chicken_breast'] },
  { key: 'ground_turkey', name: 'ground turkey', category: 'ground_meat', acceptCategories: ['poultry'], variants: ['GRND TURKEY {S}', 'GROUND TURKEY 93/7 {S}', 'TURKEY GRND {S}', 'GR TURKEY 85/15 {S}', 'LEAN GRND TURKEY {S}', 'TKY GRND {S}'], packages: [...LB(1, 3)], lookalikes: ['ground_beef', 'ground_chicken', 'deli_turkey'] },
  // meat
  { key: 'ground_beef', name: 'ground beef', accept: ['lean ground beef'], category: 'ground_meat', acceptCategories: ['meat'], variants: ['GRND BEEF 80/20 {S}', 'GROUND BEEF {S}', 'GRD BF 93/7 {S}', 'LEAN GRND BEEF {S}', 'GR BEEF 85/15 {S}', 'BEEF GROUND 90/10 {S}'], packages: [...LB(1, 2.25, 5)], lookalikes: ['ground_turkey', 'beef_steak'] },
  { key: 'beef_steak', name: 'steak', accept: ['ribeye steak', 'sirloin steak', 'beef steak', 'ny strip steak'], category: 'meat', variants: ['RIBEYE STEAK {S}', 'SIRLOIN STK {S}', 'NY STRIP {S}', 'TOP SIRLOIN {S}', 'CHOICE RIBEYE {S}', 'BEEF STEAK {S}'], packages: [...LB(1.2, 2.5)], lookalikes: ['ground_beef'] },
  { key: 'pork_chops', name: 'pork chops', accept: ['pork chop', 'boneless pork chops'], category: 'meat', variants: ['PORK CHOPS {S}', 'BNLS PORK CHOP {S}', 'PORK LOIN CHOP {S}', 'CTR CUT CHOPS {S}', 'PK CHOPS {S}', 'CHOPS PORK BNLS {S}'], packages: [...LB(1.5, 3)], lookalikes: ['pork_tenderloin'] },
  { key: 'pork_tenderloin', name: 'pork tenderloin', category: 'meat', variants: ['PORK TENDERLOIN {S}', 'PK TNDRLN {S}', 'TENDERLOIN PORK {S}', 'PORK TNDRLOIN {S}', 'SEAS PORK TDLN {S}', 'PORK TENDER {S}'], packages: [...LB(1.25, 2.5)], lookalikes: ['pork_chops'] },
  { key: 'bacon', name: 'bacon', accept: ['thick cut bacon', 'sliced bacon'], category: 'meat', acceptCategories: ['deli_meat'], variants: ['BACON THICK CUT {S}', 'BACON {S}', 'THK CUT BACON {S}', 'HICKORY BACON {S}', 'BACON SLCD {S}', 'APPLEWOOD BACON {S}'], packages: [...OZ(12, 16), p('2X1.5 LB', 1.5, 'lb', 2)] },
  { key: 'italian_sausage', name: 'italian sausage', accept: ['italian sausage links'], category: 'ground_meat', acceptCategories: ['meat'], variants: ['ITAL SAUSAGE {S}', 'MILD ITAL SAUS {S}', 'ITALIAN SAUSAGE {S}', 'HOT ITAL LINKS {S}', 'SAUSAGE ITAL {S}', 'ITL SSG MILD {S}'], packages: [...LB(1, 2.5), p('19 OZ', 19, 'oz')] },
  // seafood
  { key: 'salmon', name: 'salmon', accept: ['salmon fillet', 'atlantic salmon', 'salmon fillets'], category: 'seafood', variants: ['ATL SALMON FLT {S}', 'SALMON FILLET {S}', 'SALMON {S}', 'FRSH ATL SALMON {S}', 'SOCKEYE SALMON {S}', 'SLMN FILET {S}'], packages: [...LB(1, 2.5)], lookalikes: ['tilapia'] },
  { key: 'shrimp', name: 'shrimp', accept: ['raw shrimp', 'cooked shrimp'], category: 'seafood', acceptCategories: ['frozen_foods'], variants: ['RAW SHRIMP 31/40 {S}', 'SHRIMP EZ PEEL {S}', 'SHRIMP {S}', 'CKD SHRIMP {S}', 'SHRMP 21/25 {S}', 'LG SHRIMP RAW {S}'], packages: [...LB(1, 2)] },
  { key: 'tilapia', name: 'tilapia', accept: ['tilapia fillets'], category: 'seafood', acceptCategories: ['frozen_foods'], variants: ['TILAPIA FLTS {S}', 'TILAPIA {S}', 'TILAPIA FILLET {S}', 'TLPA FLT {S}', 'FRZ TILAPIA {S}', 'FISH TILAPIA {S}'], packages: [...LB(1, 2)], lookalikes: ['salmon'] },
  // deli
  { key: 'deli_turkey', name: 'deli turkey', accept: ['sliced turkey', 'turkey breast', 'turkey lunch meat', 'sliced turkey breast'], category: 'deli_meat', variants: ['OVEN RST TURKEY {S}', 'DELI TURKEY {S}', 'TKY BRST SLCD {S}', 'SLICED TURKEY {S}', 'SMKD TURKEY DELI {S}', 'TURKEY BREAST DELI {S}'], packages: [...OZ(8, 16)], lookalikes: ['ground_turkey'] },
  { key: 'ham', name: 'ham', accept: ['deli ham', 'sliced ham'], category: 'deli_meat', variants: ['BLK FOREST HAM {S}', 'DELI HAM {S}', 'HAM SLCD {S}', 'HONEY HAM {S}', 'SLICED HAM {S}', 'HAM HONEY DELI {S}'], packages: [...OZ(8, 16)] },
  { key: 'salami', name: 'salami', accept: ['genoa salami'], category: 'deli_meat', variants: ['GENOA SALAMI {S}', 'SALAMI {S}', 'SLCD SALAMI {S}', 'HARD SALAMI {S}', 'SALAMI GENOA {S}', 'SLM SLICED {S}'], packages: [...OZ(4, 8)] },
  { key: 'hot_dogs', name: 'hot dogs', accept: ['franks', 'beef franks'], category: 'deli_meat', acceptCategories: ['meat'], variants: ['BEEF FRANKS {S}', 'HOT DOGS {S}', 'FRANKS BEEF {S}', 'UNCURED FRANKS {S}', 'HOTDOG BEEF {S}', 'BF FRANKS {S}'], packages: [...OZ(14), p('2X3 LB', 3, 'lb', 2)] },
  // plant protein
  { key: 'tofu', name: 'tofu', accept: ['firm tofu', 'extra firm tofu'], category: 'plant_protein', variants: ['XFIRM TOFU {S}', 'TOFU FIRM {S}', 'ORG TOFU XF {S}', 'EXTRA FIRM TOFU {S}', 'TOFU {S}', 'FIRM TOFU {S}'], packages: [...OZ(14, 16)] },
  { key: 'hummus', name: 'hummus', category: 'plant_protein', acceptCategories: ['sauces', 'condiments', 'snacks'], variants: ['HUMMUS CLASSIC {S}', 'HUMMUS {S}', 'ORIG HUMMUS {S}', 'RSTD GARLIC HUMMUS {S}', 'HUMUS {S}', 'HUMMUS TUB {S}'], packages: [...OZ(10, 17)] },
  // leafy greens
  { key: 'baby_spinach', name: 'baby spinach', accept: ['spinach'], category: 'leafy_greens', variants: ['BABY SPINACH {S}', 'SPINACH BABY {S}', 'BBY SPINACH {S}', 'ORG BABY SPIN {S}', 'BABY SPNCH {S}', 'SPINACH BBY LEAF {S}'], packages: [...OZ(5, 10, 16), p('1 LB', 1, 'lb')], lookalikes: ['spring_mix', 'kale'] },
  { key: 'spring_mix', name: 'spring mix', accept: ['salad mix', 'mixed greens'], category: 'leafy_greens', variants: ['SPRING MIX {S}', 'SPRNG MIX {S}', 'ORG SPRING MIX {S}', 'MIXED GREENS {S}', 'SPR MIX SALAD {S}', 'SALAD SPRING MIX {S}'], packages: [...OZ(5, 16)], lookalikes: ['baby_spinach', 'romaine'] },
  { key: 'romaine', name: 'romaine lettuce', accept: ['romaine', 'romaine hearts'], category: 'leafy_greens', variants: ['ROMAINE HEARTS {S}', 'ROMAINE {S}', 'ROM HEARTS {S}', 'ROMAINE LETTUCE', 'LETTUCE ROMAINE', 'ROMAINE HRTS {S}'], packages: [...CT(3, 6)], lookalikes: ['spring_mix'] },
  { key: 'kale', name: 'kale', accept: ['curly kale', 'lacinato kale'], category: 'leafy_greens', variants: ['KALE BUNCH', 'CURLY KALE', 'KALE CHOPPED {S}', 'LACINATO KALE', 'KALE ORG', 'TUSCAN KALE'], packages: [...OZ(10, 16)], lookalikes: ['baby_spinach'] },
  // berries
  { key: 'strawberries', name: 'strawberries', accept: ['strawberry'], category: 'berries', variants: ['STRAWBERRIES {S}', 'STRWBRY {S}', 'STRAWBERRY {S}', 'ORG STRAWBERRIES {S}', 'STRAWB {S}', 'BERRIES STRAWBERRY {S}'], packages: [...LB(1, 2), p('16 OZ', 16, 'oz')], lookalikes: ['raspberries'] },
  { key: 'blueberries', name: 'blueberries', accept: ['blueberry'], category: 'berries', variants: ['BLUEBERRIES {S}', 'BLUEBRY {S}', 'BLUEBERRY {S}', 'ORG BLUEBERRIES {S}', 'BLU BERRIES {S}', 'BERRIES BLUE {S}'], packages: [...OZ(6, 11, 18), p('2 LB', 2, 'lb'), p('1 PT', 1, 'pt')], lookalikes: ['raspberries', 'blackberries'] },
  { key: 'raspberries', name: 'raspberries', accept: ['raspberry'], category: 'berries', variants: ['RASPBERRIES {S}', 'RASPBRY {S}', 'RASPBERRY {S}', 'ORG RASPBERRIES {S}', 'RSPBRRY {S}', 'BERRIES RASP {S}'], packages: [...OZ(6, 12)], lookalikes: ['strawberries', 'blackberries'] },
  { key: 'blackberries', name: 'blackberries', accept: ['blackberry'], category: 'berries', variants: ['BLACKBERRIES {S}', 'BLKBRY {S}', 'BLACKBERRY {S}', 'ORG BLACKBERRIES {S}', 'BLK BERRIES {S}', 'BERRIES BLACK {S}'], packages: [...OZ(6, 12)], lookalikes: ['blueberries', 'raspberries'] },
  // fruit
  { key: 'bananas', name: 'bananas', accept: ['banana'], category: 'fruit', byWeight: true, variants: ['BANANAS', 'BANANA', 'BANANAS ORG', 'BAN YELLOW', 'ORGANIC BANANAS', 'BANANAS BUNCH'], packages: [p('3 LB', 3, 'lb')], lookalikes: ['plantains'] },
  { key: 'plantains', name: 'plantains', accept: ['plantain'], category: 'fruit', acceptCategories: ['vegetables'], byWeight: true, variants: ['PLANTAINS', 'PLANTAIN GREEN', 'PLANTAIN', 'PLANTAINS YLW', 'GREEN PLANTAIN', 'PLNTN'], packages: [], lookalikes: ['bananas'] },
  { key: 'apples', name: 'apples', accept: ['apple', 'honeycrisp apples', 'gala apples'], category: 'fruit', variants: ['HONEYCRISP APPLES {S}', 'GALA APPLES {S}', 'APPLES FUJI {S}', 'HNYCRSP APL {S}', 'GRANNY SMITH APL {S}', 'APPLE GALA BAG {S}'], packages: [...LB(3, 5)] },
  { key: 'lemons', name: 'lemons', accept: ['lemon'], category: 'fruit', variants: ['LEMONS {S}', 'LEMON', 'LEMONS BAG {S}', 'MEYER LEMONS {S}', 'LEMON EA', 'LMNS {S}'], packages: [...LB(2)], lookalikes: ['limes'] },
  { key: 'limes', name: 'limes', accept: ['lime'], category: 'fruit', variants: ['LIMES {S}', 'LIME', 'LIMES BAG {S}', 'PERSIAN LIMES {S}', 'LIME EA', 'LMS BAG {S}'], packages: [...LB(2)], lookalikes: ['lemons'] },
  { key: 'avocados', name: 'avocados', accept: ['avocado', 'hass avocados'], category: 'fruit', acceptCategories: ['vegetables'], variants: ['AVOCADOS {S}', 'HASS AVOCADO', 'AVOCADO BAG {S}', 'AVOCADOS HASS {S}', 'AVOCADO LG', 'AVO BAG {S}'], packages: [...CT(4, 6), ...LB(3)] },
  { key: 'grapes', name: 'grapes', accept: ['red grapes', 'green grapes', 'seedless grapes'], category: 'fruit', byWeight: true, variants: ['RED SDLS GRAPES', 'GREEN GRAPES', 'GRAPES RED', 'SEEDLESS GRAPES', 'GRAPES CTTN CANDY', 'GRP RED SDLS'], packages: [p('3 LB', 3, 'lb'), p('2 LB', 2, 'lb')] },
  { key: 'oranges', name: 'oranges', accept: ['orange', 'navel oranges'], category: 'fruit', variants: ['NAVEL ORANGES {S}', 'ORANGES {S}', 'VALENCIA ORANGES {S}', 'ORANGES BAG {S}', 'CARA CARA ORNG {S}', 'ORNG NAVEL {S}'], packages: [...LB(3, 4, 5)], lookalikes: ['orange_juice'] },
  // vegetables
  { key: 'cherry_tomatoes', name: 'cherry tomatoes', accept: ['grape tomatoes', 'cherry tomato'], category: 'vegetables', acceptCategories: ['fruit'], variants: ['CHERRY TOMATOES {S}', 'GRAPE TOMATOES {S}', 'CHRY TOM {S}', 'TOMATO CHERRY {S}', 'CHERRY TOMS {S}', 'GRAPE TOM {S}'], packages: [...OZ(10, 16), p('1 PT', 1, 'pt'), p('2 LB', 2, 'lb')], lookalikes: ['tomatoes'] },
  { key: 'tomatoes', name: 'tomatoes', accept: ['roma tomatoes', 'tomato', 'vine tomatoes'], category: 'vegetables', acceptCategories: ['fruit'], byWeight: true, variants: ['ROMA TOMATOES', 'TOMATOES ON VINE', 'TOMATO ROMA', 'TOV TOMATOES', 'BEEFSTEAK TOMATO', 'TOMATOES HOTHOUSE'], packages: [p('4 LB', 4, 'lb')], lookalikes: ['cherry_tomatoes', 'canned_tomatoes'] },
  { key: 'bell_peppers', name: 'bell peppers', accept: ['bell pepper', 'red bell pepper', 'mini peppers', 'sweet peppers'], category: 'vegetables', variants: ['RED BELL PEPPER', 'BELL PEPPERS 3CT', 'MINI SWEET PEPPERS {S}', 'PEPPERS BELL MIX', 'GRN BELL PEPPER', 'BELL PPR RED'], packages: [p('3 CT', 3, 'ct'), ...LB(1, 2)] },
  { key: 'broccoli', name: 'broccoli', accept: ['broccoli florets', 'broccoli crowns'], category: 'vegetables', acceptCategories: ['frozen_foods'], variants: ['BROCCOLI CROWNS', 'BROCCOLI FLORETS {S}', 'BROC CROWNS', 'BROCCOLI', 'BRCLI FLRTS {S}', 'ORG BROCCOLI'], packages: [...OZ(12, 32), ...LB(2)] },
  { key: 'cucumbers', name: 'cucumbers', accept: ['cucumber', 'english cucumber', 'mini cucumbers'], category: 'vegetables', variants: ['ENGLISH CUCUMBER', 'CUCUMBERS', 'MINI CUCUMBERS {S}', 'CUKES PERSIAN {S}', 'CUCUMBER EA', 'SEEDLESS CUKE'], packages: [...LB(1, 2)] },
  { key: 'zucchini', name: 'zucchini', category: 'vegetables', byWeight: true, variants: ['ZUCCHINI', 'ZUCCHINI SQUASH', 'GREEN ZUCCHINI', 'ZUCC', 'SQUASH ZUCCHINI', 'ZUCCHINI ORG'], packages: [p('2 LB', 2, 'lb')] },
  { key: 'mushrooms', name: 'mushrooms', accept: ['white mushrooms', 'baby bella mushrooms', 'cremini mushrooms', 'sliced mushrooms'], category: 'vegetables', variants: ['WHITE MUSHROOMS {S}', 'BABY BELLA MUSH {S}', 'SLCD MUSHROOMS {S}', 'CREMINI MUSHRM {S}', 'MUSHROOMS WHT {S}', 'MUSH BBY BELLA {S}'], packages: [...OZ(8, 16, 24)] },
  { key: 'asparagus', name: 'asparagus', category: 'vegetables', variants: ['ASPARAGUS', 'ASPARAGUS BUNCH', 'ASPAR {S}', 'GREEN ASPARAGUS {S}', 'ASPARAGUS TIPS {S}', 'ORG ASPARAGUS'], packages: [...LB(1, 2)] },
  { key: 'green_beans', name: 'green beans', accept: ['haricots verts'], category: 'vegetables', acceptCategories: ['frozen_foods'], variants: ['GREEN BEANS {S}', 'HARICOT VERT {S}', 'GRN BEANS {S}', 'FRENCH GRN BEANS {S}', 'BEANS GREEN {S}', 'STRING BEANS {S}'], packages: [...OZ(12, 16), p('2 LB', 2, 'lb')], lookalikes: ['black_beans'] },
  { key: 'celery', name: 'celery', accept: ['celery hearts'], category: 'vegetables', variants: ['CELERY HEARTS', 'CELERY', 'CELERY STALK', 'CELERY BUNCH', 'CLRY HEARTS', 'ORG CELERY'], packages: [] },
  { key: 'corn', name: 'corn', accept: ['sweet corn', 'corn on the cob'], category: 'vegetables', variants: ['SWEET CORN EA', 'CORN ON COB', 'CORN YELLOW', 'BI COLOR CORN', 'CORN 4CT {S}', 'SWT CORN'], packages: [p('4 CT', 4, 'ct')] },
  // roots
  { key: 'potatoes', name: 'potatoes', accept: ['russet potatoes', 'yukon gold potatoes', 'potato', 'baby potatoes'], category: 'root_vegetables', variants: ['RUSSET POTATOES {S}', 'YUKON GOLD {S}', 'POTATOES RED {S}', 'BABY POTATOES {S}', 'RSSET POT {S}', 'POTATO YKN GLD {S}'], packages: [...LB(5, 10, 3)], lookalikes: ['sweet_potatoes'] },
  { key: 'sweet_potatoes', name: 'sweet potatoes', accept: ['sweet potato', 'yams'], category: 'root_vegetables', byWeight: true, variants: ['SWEET POTATOES', 'SWT POTATO', 'YAMS', 'SWEET POTATO', 'GARNET YAMS', 'SWT POT {S}'], packages: [p('3 LB', 3, 'lb')], lookalikes: ['potatoes'] },
  { key: 'onions', name: 'onions', accept: ['yellow onions', 'red onions', 'onion'], category: 'root_vegetables', variants: ['YELLOW ONIONS {S}', 'RED ONION', 'ONIONS YLW {S}', 'SWEET ONIONS {S}', 'YLW ONION BAG {S}', 'ONION RED EA'], packages: [...LB(3, 5)], lookalikes: ['green_onions', 'shallots'] },
  { key: 'garlic', name: 'garlic', accept: ['peeled garlic', 'garlic bulbs'], category: 'root_vegetables', acceptCategories: ['herbs', 'vegetables'], variants: ['GARLIC BULB', 'PEELED GARLIC {S}', 'GARLIC 3CT', 'GARLIC', 'GRLC PEELED {S}', 'GARLIC WHOLE'], packages: [...OZ(6), p('3 LB', 3, 'lb')] },
  { key: 'carrots', name: 'carrots', accept: ['baby carrots', 'carrot'], category: 'root_vegetables', variants: ['BABY CARROTS {S}', 'CARROTS {S}', 'CARROTS WHOLE {S}', 'BBY CARROTS {S}', 'ORG CARROTS {S}', 'CARROT BAG {S}'], packages: [...LB(1, 2, 5), ...OZ(16)] },
  { key: 'shallots', name: 'shallots', accept: ['shallot'], category: 'root_vegetables', variants: ['SHALLOTS {S}', 'SHALLOT', 'SHALLOTS BAG {S}', 'SHLT {S}', 'FRENCH SHALLOTS {S}', 'SHALLOT EA'], packages: [...OZ(8, 16)], lookalikes: ['onions'] },
  { key: 'ginger', name: 'ginger', accept: ['ginger root', 'fresh ginger'], category: 'root_vegetables', acceptCategories: ['herbs'], byWeight: true, variants: ['GINGER ROOT', 'GINGER', 'FRESH GINGER', 'GNGR ROOT', 'GINGER ORG', 'ROOT GINGER'], packages: [] },
  // herbs
  { key: 'cilantro', name: 'cilantro', category: 'herbs', variants: ['CILANTRO', 'CILANTRO BUNCH', 'CILANTRO ORG', 'CLNTRO', 'CORIANDER CILANTRO', 'HERB CILANTRO'], packages: [], lookalikes: ['parsley'] },
  { key: 'parsley', name: 'parsley', accept: ['flat leaf parsley', 'italian parsley'], category: 'herbs', variants: ['ITALIAN PARSLEY', 'PARSLEY FLAT', 'PARSLEY CURLY', 'PRSLY ITAL', 'HERB PARSLEY', 'PARSLEY BUNCH'], packages: [], lookalikes: ['cilantro'] },
  { key: 'basil', name: 'basil', accept: ['fresh basil'], category: 'herbs', variants: ['BASIL {S}', 'FRESH BASIL {S}', 'BASIL CLAMSHELL {S}', 'SWEET BASIL {S}', 'HERB BASIL {S}', 'BSL FRSH {S}'], packages: [...OZ(0.75, 2)], lookalikes: ['pesto'] },
  { key: 'green_onions', name: 'green onions', accept: ['scallions', 'green onion', 'scallion'], category: 'herbs', acceptCategories: ['vegetables', 'root_vegetables'], variants: ['GREEN ONIONS', 'SCALLIONS', 'GRN ONION BUNCH', 'SCALLION', 'GREEN ONION', 'ONIONS GREEN'], packages: [], lookalikes: ['onions'] },
  // bread
  { key: 'sandwich_bread', name: 'bread', accept: ['sandwich bread', 'wheat bread', 'white bread', 'whole wheat bread', 'sliced bread'], category: 'bread', variants: ['WHOLE WHEAT BREAD {S}', 'WHITE BREAD {S}', 'BREAD 100% WW {S}', 'SANDWICH BREAD {S}', 'WW BREAD {S}', 'BRD WHT SNDWCH {S}'], packages: [...OZ(20, 24), p('2X27 OZ', 27, 'oz', 2)], lookalikes: ['sourdough'] },
  { key: 'sourdough', name: 'sourdough bread', accept: ['sourdough', 'sourdough loaf'], category: 'bread', variants: ['SOURDOUGH LOAF', 'SOURDOUGH ROUND', 'SRDGH BREAD {S}', 'SOURDOUGH SLCD {S}', 'SF SOURDOUGH', 'BREAD SOURDOUGH {S}'], packages: [...OZ(24, 32)], lookalikes: ['sandwich_bread'] },
  { key: 'tortillas', name: 'tortillas', accept: ['flour tortillas', 'corn tortillas', 'tortilla'], category: 'bread', variants: ['FLOUR TORTILLAS {S}', 'CORN TORTILLAS {S}', 'TORTILLAS FLR {S}', 'UNCOOKED TORTILLA {S}', 'TORT FLOUR {S}', 'STREET TACO TORT {S}'], packages: [...CT(10, 30, 44)], lookalikes: ['tortilla_chips'] },
  { key: 'bagels', name: 'bagels', accept: ['bagel', 'plain bagels', 'everything bagels'], category: 'bread', variants: ['PLAIN BAGELS {S}', 'EVERYTHING BAGEL {S}', 'BAGELS {S}', 'BGL PLAIN {S}', 'NY BAGELS {S}', 'BAGELS EVRYTHNG {S}'], packages: [...CT(6, 12)] },
  { key: 'english_muffins', name: 'english muffins', accept: ['english muffin'], category: 'bread', variants: ['ENGLISH MUFFINS {S}', 'ENG MUFFINS {S}', 'ENGLISH MUFFIN {S}', 'ENG MFNS {S}', 'MUFFINS ENGLISH {S}', 'ORIG ENG MUFFIN {S}'], packages: [...CT(6, 12)] },
  // grains & pasta
  { key: 'spaghetti', name: 'spaghetti', accept: ['spaghetti pasta'], category: 'grains_pasta', variants: ['SPAGHETTI {S}', 'SPAGHETTI PASTA {S}', 'PASTA SPAGHETTI {S}', 'SPGHTI {S}', 'THIN SPAGHETTI {S}', 'SPAG NO 5 {S}'], packages: [...LB(1), p('6X1 LB', 1, 'lb', 6)], lookalikes: ['penne'] },
  { key: 'penne', name: 'penne', accept: ['penne pasta', 'penne rigate'], category: 'grains_pasta', variants: ['PENNE RIGATE {S}', 'PENNE PASTA {S}', 'PASTA PENNE {S}', 'PENNE {S}', 'PNNE RGT {S}', 'WW PENNE {S}'], packages: [...LB(1), p('6X1 LB', 1, 'lb', 6)], lookalikes: ['spaghetti'] },
  { key: 'rice', name: 'rice', accept: ['jasmine rice', 'basmati rice', 'white rice', 'long grain rice'], category: 'grains_pasta', variants: ['JASMINE RICE {S}', 'BASMATI RICE {S}', 'LONG GRAIN RICE {S}', 'RICE JASMINE {S}', 'CALROSE RICE {S}', 'WHITE RICE LG {S}'], packages: [...LB(2, 10, 25)], lookalikes: ['brown_rice'] },
  { key: 'brown_rice', name: 'brown rice', category: 'grains_pasta', variants: ['BROWN RICE {S}', 'RICE BROWN {S}', 'BRN RICE {S}', 'LG BROWN RICE {S}', 'ORG BROWN RICE {S}', 'BRWN RICE {S}'], packages: [...LB(2, 5)], lookalikes: ['rice'] },
  { key: 'oats', name: 'oats', accept: ['rolled oats', 'old fashioned oats', 'oatmeal'], category: 'grains_pasta', variants: ['OLD FASHIONED OATS {S}', 'ROLLED OATS {S}', 'OATS QUICK {S}', 'ORG OATS {S}', 'OATMEAL OLD FSHN {S}', 'STEEL CUT OATS {S}'], packages: [...OZ(42), p('2X5 LB', 5, 'lb', 2), p('10 LB', 10, 'lb')] },
  { key: 'cereal', name: 'cereal', accept: ['cheerios', 'breakfast cereal', 'granola cereal'], category: 'grains_pasta', acceptCategories: ['snacks'], variants: ['HONEY NUT CEREAL {S}', 'TOASTED OATS CRL {S}', 'CEREAL CORN FLKS {S}', 'CRL RAISIN BRAN {S}', 'FROSTED FLAKES {S}', 'CHEERIOS {S}'], packages: [...OZ(12, 18), p('2X20.4 OZ', 20.4, 'oz', 2)] },
  { key: 'quinoa', name: 'quinoa', category: 'grains_pasta', variants: ['QUINOA {S}', 'ORG QUINOA {S}', 'TRICOLOR QUINOA {S}', 'QUINOA WHITE {S}', 'QUINOA ORG {S}', 'QNOA {S}'], packages: [...LB(1, 4.5)] },
  // canned
  { key: 'chickpeas', name: 'canned chickpeas', accept: ['chickpeas', 'garbanzo beans'], category: 'canned_goods', variants: ['CHICKPEAS {S} CAN', 'GARBANZO BEANS {S}', 'CHICK PEAS {S}', 'GARBANZOS {S} CN', 'CHKPEA {S}', 'BEANS GARBANZO {S}'], packages: [...OZ(15.5, 15), p('8X15.5 OZ', 15.5, 'oz', 8)], lookalikes: ['black_beans'] },
  { key: 'black_beans', name: 'canned black beans', accept: ['black beans'], category: 'canned_goods', variants: ['BLACK BEANS {S}', 'BLK BEANS {S}', 'BEANS BLACK {S} CAN', 'ORG BLK BEANS {S}', 'BLACK BEAN {S}', 'BLK BN LOW SOD {S}'], packages: [...OZ(15), p('8X15 OZ', 15, 'oz', 8)], lookalikes: ['chickpeas', 'green_beans'] },
  { key: 'canned_tomatoes', name: 'canned tomatoes', accept: ['diced tomatoes', 'crushed tomatoes', 'whole peeled tomatoes'], category: 'canned_goods', variants: ['DICED TOMATOES {S}', 'CRUSHED TOM {S}', 'TOM DICED {S} CAN', 'WHOLE PEELED TOM {S}', 'SAN MARZANO {S}', 'TOMATOES DCD {S}'], packages: [...OZ(14.5, 28), p('8X14.5 OZ', 14.5, 'oz', 8)], lookalikes: ['tomatoes', 'pasta_sauce', 'tomato_paste'] },
  { key: 'tomato_paste', name: 'tomato paste', category: 'canned_goods', acceptCategories: ['sauces'], variants: ['TOMATO PASTE {S}', 'TOM PASTE {S}', 'PASTE TOMATO {S}', 'TMTO PASTE {S}', 'DOUBLE CONC PASTE {S}', 'TOMATO PST {S}'], packages: [...OZ(6, 4.5)], lookalikes: ['canned_tomatoes'] },
  { key: 'canned_tuna', name: 'canned tuna', accept: ['tuna'], category: 'canned_goods', variants: ['CHUNK LIGHT TUNA {S}', 'ALBACORE TUNA {S}', 'TUNA IN WATER {S}', 'TUNA CHNK LT {S}', 'SOLID WHT TUNA {S}', 'TUNA CAN {S}'], packages: [...OZ(5), p('8X7 OZ', 7, 'oz', 8)], lookalikes: ['salmon'] },
  { key: 'chicken_broth', name: 'chicken broth', accept: ['chicken stock'], category: 'canned_goods', variants: ['CHICKEN BROTH {S}', 'CHKN STOCK {S}', 'BROTH CHICKEN {S}', 'LOW SOD CHKN BRTH {S}', 'CHICKEN STOCK {S}', 'ORG CHKN BROTH {S}'], packages: [p('32 OZ', 32, 'oz'), p('6X32 OZ', 32, 'oz', 6), p('14.5 OZ', 14.5, 'oz')] },
  { key: 'coconut_milk', name: 'coconut milk', category: 'canned_goods', variants: ['COCONUT MILK {S}', 'CCNT MILK {S}', 'LITE COCONUT MLK {S}', 'COCONUT MILK CAN {S}', 'COCO MILK {S}', 'MILK COCONUT {S}'], packages: [...OZ(13.5)], lookalikes: ['whole_milk'] },
  // sauces & condiments
  { key: 'pasta_sauce', name: 'pasta sauce', accept: ['marinara sauce', 'marinara', 'tomato basil sauce'], category: 'sauces', variants: ['MARINARA SAUCE {S}', 'PASTA SAUCE {S}', 'TOM BASIL SAUCE {S}', 'MARINARA {S}', 'SAUCE MARINARA {S}', 'ARRABBIATA {S}'], packages: [...OZ(24, 32), p('2X32 OZ', 32, 'oz', 2)], lookalikes: ['canned_tomatoes'] },
  { key: 'salsa', name: 'salsa', category: 'sauces', variants: ['SALSA MEDIUM {S}', 'MILD SALSA {S}', 'SALSA {S}', 'PICO DE GALLO {S}', 'SALSA VERDE {S}', 'CHUNKY SALSA {S}'], packages: [...OZ(16, 24)] },
  { key: 'pesto', name: 'pesto', accept: ['basil pesto'], category: 'sauces', variants: ['BASIL PESTO {S}', 'PESTO {S}', 'PESTO GENOVESE {S}', 'PSTO BASIL {S}', 'REFRIG PESTO {S}', 'PESTO SAUCE {S}'], packages: [...OZ(6, 7)], lookalikes: ['basil'] },
  { key: 'ketchup', name: 'ketchup', category: 'condiments', variants: ['KETCHUP {S}', 'TOMATO KETCHUP {S}', 'KETCHUP SQZ {S}', 'CATSUP {S}', 'KTCHP {S}', 'KETCHUP ORG {S}'], packages: [...OZ(20, 32), p('2X44 OZ', 44, 'oz', 2)] },
  { key: 'mayonnaise', name: 'mayonnaise', accept: ['mayo'], category: 'condiments', variants: ['MAYONNAISE {S}', 'MAYO REAL {S}', 'REAL MAYO {S}', 'MAYO {S}', 'AVOCADO OIL MAYO {S}', 'MYNS {S}'], packages: [...OZ(30, 12)] },
  { key: 'peanut_butter', name: 'peanut butter', category: 'condiments', acceptCategories: ['dry_goods', 'snacks'], variants: ['CREAMY PEANUT BTR {S}', 'PEANUT BUTTER {S}', 'PB CRUNCHY {S}', 'NAT PEANUT BUTTER {S}', 'PNT BTR CRMY {S}', 'PEANUT BUTTER CRMY {S}'], packages: [...OZ(16, 40), p('2X28 OZ', 28, 'oz', 2)], lookalikes: ['butter'] },
  { key: 'soy_sauce', name: 'soy sauce', category: 'condiments', variants: ['SOY SAUCE {S}', 'LOW SOD SOY {S}', 'SOY SCE {S}', 'TAMARI {S}', 'SOY SAUCE LS {S}', 'SHOYU {S}'], packages: [p('15 FL OZ', 15, 'fl_oz'), p('10 FL OZ', 10, 'fl_oz'), p('64 FL OZ', 64, 'fl_oz')] },
  { key: 'jam', name: 'jam', accept: ['strawberry jam', 'jelly', 'preserves', 'grape jelly'], category: 'condiments', variants: ['STRAWBERRY JAM {S}', 'GRAPE JELLY {S}', 'RASP PRESERVES {S}', 'JAM STRWBRY {S}', 'APRICOT PRSV {S}', 'JELLY GRAPE {S}'], packages: [...OZ(18, 12)], lookalikes: ['strawberries'] },
  // dry goods
  { key: 'flour', name: 'flour', accept: ['all purpose flour', 'all-purpose flour'], category: 'dry_goods', variants: ['AP FLOUR {S}', 'ALL PURPOSE FLOUR {S}', 'FLOUR UNBLEACHED {S}', 'FLOUR AP {S}', 'BREAD FLOUR {S}', 'UNBLCH FLR {S}'], packages: [...LB(5, 10, 25)], lookalikes: ['sugar'] },
  { key: 'sugar', name: 'sugar', accept: ['granulated sugar', 'cane sugar'], category: 'dry_goods', variants: ['GRANULATED SUGAR {S}', 'CANE SUGAR {S}', 'SUGAR {S}', 'PURE CANE SGR {S}', 'SUGAR GRAN {S}', 'ORG CANE SUGAR {S}'], packages: [...LB(4, 10)], lookalikes: ['brown_sugar', 'flour'] },
  { key: 'brown_sugar', name: 'brown sugar', category: 'dry_goods', variants: ['BROWN SUGAR {S}', 'LT BROWN SUGAR {S}', 'DARK BRN SUGAR {S}', 'SUGAR BROWN {S}', 'BRN SUGAR {S}', 'LIGHT BRN SGR {S}'], packages: [...LB(2, 4)], lookalikes: ['sugar'] },
  { key: 'olive_oil', name: 'olive oil', accept: ['extra virgin olive oil'], category: 'dry_goods', variants: ['EVOO {S}', 'EXTRA VIRGIN OLIVE {S}', 'OLIVE OIL {S}', 'XVOO {S}', 'OLV OIL EV {S}', 'EV OLIVE OIL {S}'], packages: [p('2 L', 2, 'l'), p('1 L', 1, 'l'), p('16.9 FL OZ', 16.9, 'fl_oz'), p('500 ML', 500, 'ml')], lookalikes: ['vegetable_oil'] },
  { key: 'vegetable_oil', name: 'vegetable oil', accept: ['canola oil', 'cooking oil'], category: 'dry_goods', variants: ['CANOLA OIL {S}', 'VEGETABLE OIL {S}', 'VEG OIL {S}', 'CANOLA {S}', 'VEGETABLE OIL BLEND {S}', 'OIL VEGETABLE {S}'], packages: [p('48 FL OZ', 48, 'fl_oz'), p('1 GAL', 1, 'gal')], lookalikes: ['olive_oil'] },
  { key: 'honey', name: 'honey', category: 'dry_goods', acceptCategories: ['condiments'], variants: ['HONEY {S}', 'RAW HONEY {S}', 'CLOVER HONEY {S}', 'HONEY BEAR {S}', 'WILDFLOWER HONEY {S}', 'HNY RAW {S}'], packages: [...OZ(12, 24), p('3 LB', 3, 'lb')] },
  // snacks
  { key: 'tortilla_chips', name: 'tortilla chips', accept: ['restaurant style chips', 'corn chips'], category: 'snacks', variants: ['TORTILLA CHIPS {S}', 'TORT CHIPS {S}', 'CHIPS TORTILLA {S}', 'YELLOW CORN CHIPS {S}', 'RESTAURANT STYLE CHIPS {S}', 'TRTLA CHPS {S}'], packages: [...OZ(13, 32)], lookalikes: ['tortillas'] },
  { key: 'almonds', name: 'almonds', accept: ['roasted almonds', 'raw almonds'], category: 'snacks', acceptCategories: ['dry_goods'], variants: ['ALMONDS RAW {S}', 'ROASTED ALMONDS {S}', 'WHOLE ALMONDS {S}', 'ALMND UNSLTD {S}', 'ALMONDS {S}', 'NUTS ALMOND {S}'], packages: [...OZ(16), p('3 LB', 3, 'lb')], lookalikes: ['almond_milk'] },
  { key: 'crackers', name: 'crackers', accept: ['wheat crackers', 'saltines'], category: 'snacks', variants: ['WHEAT CRACKERS {S}', 'SALTINES {S}', 'CRACKERS BUTTERY {S}', 'CRKRS WHT {S}', 'SEA SALT CRACKERS {S}', 'CRACKER ORIG {S}'], packages: [...OZ(9, 16)] },
  { key: 'granola_bars', name: 'granola bars', accept: ['granola bar', 'snack bars', 'nut bars', 'honey oat bars', 'oat bars'], category: 'snacks', variants: ['GRANOLA BARS {S}', 'CHWY GRANOLA BAR {S}', 'NUT BARS {S}', 'BARS GRANOLA {S}', 'OATS HONEY BARS {S}', 'GRNLA BAR {S}'], packages: [...CT(12, 48, 6)] },
  // beverages
  { key: 'orange_juice', name: 'orange juice', accept: ['oj'], category: 'beverages', variants: ['ORANGE JUICE {S}', 'OJ NO PULP {S}', 'ORNG JUICE {S}', 'OJ HIGH PULP {S}', 'JUICE ORANGE {S}', 'FRSH SQZ OJ {S}'], packages: [p('52 FL OZ', 52, 'fl_oz'), p('89 FL OZ', 89, 'fl_oz'), p('2X59 FL OZ', 59, 'fl_oz', 2)], lookalikes: ['oranges'] },
  { key: 'sparkling_water', name: 'sparkling water', accept: ['seltzer', 'seltzer water', 'flavored sparkling water'], category: 'beverages', variants: ['SPARKLING WATER {S}', 'LIME SELTZER {S}', 'SELTZER {S}', 'SPRKLNG WTR {S}', 'LACROIX LIME {S}', 'FLAVORED SELTZER {S}'], packages: [p('12X12 FL OZ', 12, 'fl_oz', 12), p('8X12 FL OZ', 12, 'fl_oz', 8)] },
  { key: 'coffee', name: 'coffee', accept: ['ground coffee', 'coffee beans', 'whole bean coffee'], category: 'beverages', acceptCategories: ['dry_goods'], variants: ['GROUND COFFEE {S}', 'WHOLE BEAN COFFEE {S}', 'COFFEE DK RST {S}', 'COLOMBIAN COFFEE {S}', 'COFFEE MED ROAST {S}', 'CFE WHL BN {S}'], packages: [...OZ(12), p('2.5 LB', 2.5, 'lb'), p('40 OZ', 40, 'oz')] },
  // frozen
  { key: 'frozen_peas', name: 'frozen peas', accept: ['peas', 'green peas'], category: 'frozen_foods', variants: ['FRZ PEAS {S}', 'FROZEN PEAS {S}', 'SWEET PEAS FRZN {S}', 'PEAS FROZEN {S}', 'GREEN PEAS FRZ {S}', 'PETITE PEAS {S}'], packages: [...OZ(12, 16), p('5 LB', 5, 'lb')] },
  { key: 'ice_cream', name: 'ice cream', accept: ['vanilla ice cream'], category: 'frozen_foods', acceptCategories: ['dairy'], variants: ['VANILLA ICE CREAM {S}', 'ICE CRM CHOC {S}', 'ICE CREAM {S}', 'ICE CREAM COOKIE {S}', 'IC VANILLA BEAN {S}', 'CHOC CHIP ICE CRM {S}'], packages: [p('1.5 QT', 1.5, 'qt'), p('1 PT', 1, 'pt'), p('48 FL OZ', 48, 'fl_oz')] },
  { key: 'frozen_pizza', name: 'frozen pizza', accept: ['pizza'], category: 'frozen_foods', variants: ['FRZN PIZZA PEPP {S}', 'FROZEN PIZZA {S}', 'PIZZA CHEESE FRZ {S}', 'THIN CRUST PIZZA {S}', 'PIZZA PEPPERONI {S}', 'RISING CRUST PZA {S}'], packages: [...OZ(21, 28), p('4 CT', 4, 'ct')] },
  { key: 'frozen_berries', name: 'frozen berries', accept: ['frozen mixed berries', 'mixed berries'], category: 'frozen_foods', acceptCategories: ['berries'], variants: ['FRZ MIXED BERRIES {S}', 'FROZEN BERRY BLEND {S}', 'MIXED BERRIES FRZ {S}', 'TRIPLE BERRY FRZ {S}', 'FRZ BERRY MIX {S}', 'ORG FRZN BERRIES {S}'], packages: [...LB(3, 4), p('48 OZ', 48, 'oz')], lookalikes: ['blueberries', 'strawberries'] },
  // leftovers / prepared
  { key: 'rotisserie_salad', name: 'chicken salad', accept: ['prepared chicken salad', 'deli chicken salad'], category: 'leftovers', acceptCategories: ['deli_meat', 'poultry'], variants: ['CHICKEN SALAD {S}', 'DELI CHKN SALAD {S}', 'CHKN SALAD {S}', 'CHICKEN SALAD CUP {S}', 'PREP CHKN SALAD {S}', 'SALAD CHICKEN DELI {S}'], packages: [...OZ(16, 32)], lookalikes: ['rotisserie_chicken', 'spring_mix'] },
];

export interface NonFoodItem {
  key: string;
  name: string;
  accept?: string[];
  variants: string[];
}

export const NON_FOOD: NonFoodItem[] = [
  { key: 'paper_towels', name: 'paper towels', variants: ['PAPER TOWELS 6 ROLL', 'PAPER TWL 12 RL', 'PPR TOWEL MEGA', 'TOWELS PAPER 8PK', 'KS PAPER TOWEL 12', 'PAPER TOWELS'] },
  { key: 'toilet_paper', name: 'toilet paper', accept: ['bath tissue'], variants: ['BATH TISSUE 12 MEGA', 'TOILET PAPER 30 RL', 'BATH TSSU 24PK', 'TP 12 ROLL', 'KS BATH TISSUE', 'TOILET TISSUE'] },
  { key: 'dish_soap', name: 'dish soap', accept: ['dish detergent', 'dishwashing liquid', 'dish liquid'], variants: ['DISH SOAP 28 OZ', 'DISH LIQ LEMON', 'DISHWASH LIQUID', 'DSH SOAP ULTRA', 'DISH DETERGENT', 'DISH SOAP REFILL'] },
  { key: 'laundry_detergent', name: 'laundry detergent', variants: ['LAUNDRY DET 150 OZ', 'LNDRY PODS 81CT', 'DETERGENT HE', 'LAUNDRY PACS', 'LIQ LAUNDRY DET', 'KS LAUNDRY 194 LD'] },
  { key: 'trash_bags', name: 'trash bags', accept: ['kitchen bags', 'garbage bags', 'tall kitchen bags', 'kitchen trash bags'], variants: ['TRASH BAGS 13 GAL', 'KITCHEN BAGS 80CT', 'TRSH BG DRAWSTR', 'GARBAGE BAGS 30G', 'TALL KITCHEN BAG', 'TRASH BAGS FLEX'] },
  { key: 'aluminum_foil', name: 'aluminum foil', accept: ['foil'], variants: ['ALUMINUM FOIL 75SF', 'FOIL HVY DUTY', 'ALUM FOIL', 'REYNOLDS WRAP', 'FOIL 200 SQ FT', 'ALUMINUM FOIL'] },
  { key: 'batteries', name: 'batteries', variants: ['AA BATTERIES 48PK', 'BATTERY AAA 24', 'ALKALINE AA', 'BATT AA 20CT', 'AAA BATTERIES', 'COPPERTOP AA'] },
  { key: 'sponges', name: 'sponges', variants: ['SPONGES 6PK', 'SCRUB SPONGE', 'SPONGE NON SCRTCH', 'SCRUB DADDY', 'SPNG 9CT', 'KITCHEN SPONGES'] },
  { key: 'dog_food', name: 'dog food', accept: ['dog kibble'], variants: ['DOG FOOD 40 LB', 'KS DOG FOOD LAMB', 'DRY DOG FD', 'PUPPY CHOW', 'DOG KIBBLE CHKN', 'DOG FOOD TRKY'] },
  { key: 'shampoo', name: 'shampoo', variants: ['SHAMPOO 2PK', 'SHMP MOIST', 'SHAMPOO & COND', 'SHAMPOO 33.8 OZ', 'DANDRUFF SHMP', 'SHAMPOO'] },
  { key: 'bottle_deposit', name: 'bottle deposit', accept: ['deposit', 'crv', 'redemption value', 'california redemption value'], variants: ['BTL DEPOSIT', 'CRV', 'CA REDEMPTION VAL', 'BOTTLE DEP', 'DEPOSIT 12', 'CRV 12PK'] },
  { key: 'reusable_bag', name: 'reusable bag', accept: ['bag', 'shopping bag'], variants: ['BAG FEE', 'REUSABLE BAG', 'PAPER BAG 10C', 'BAG CHARGE', 'SHOPPING BAG', 'BAG 0.10'] },
];

export const FOOD_BY_KEY = new Map(FOODS.map((f) => [f.key, f]));
