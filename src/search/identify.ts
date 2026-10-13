/** Object categories used for zero-shot identification of the uploaded photo. */
export const LABELS = [
  'sneaker', 'running shoe', 'boot', 'high heel shoe', 'sandal', 'handbag', 'backpack', 'suitcase', 'wallet', 'wristwatch',
  'sunglasses', 'hat', 'cap', 'helmet', 'glove', 'jacket', 't-shirt', 'dress', 'necklace', 'ring',
  'smartphone', 'laptop', 'tablet', 'headphones', 'earbuds', 'smart speaker', 'camera', 'game controller', 'keyboard', 'computer mouse',
  'monitor', 'television', 'drone', 'robot', 'smartwatch', 'microphone', 'guitar', 'violin', 'piano', 'drum',
  'car', 'sports car', 'pickup truck', 'motorcycle', 'bicycle', 'scooter', 'bus', 'train', 'airplane', 'helicopter',
  'boat', 'ship', 'tractor', 'tank', 'rocket', 'skateboard', 'toy car', 'toy robot', 'action figure', 'doll',
  'teddy bear', 'plush toy', 'figurine', 'statue', 'bust sculpture', 'vase', 'pot', 'mug', 'cup', 'teapot',
  'bottle', 'wine bottle', 'glass', 'bowl', 'plate', 'jar', 'can', 'box', 'gift box', 'basket',
  'chair', 'armchair', 'sofa', 'stool', 'table', 'desk', 'bed', 'lamp', 'floor lamp', 'shelf',
  'cabinet', 'clock', 'mirror', 'candle', 'plant in a pot', 'cactus', 'flower', 'tree', 'bonsai', 'mushroom',
  'apple', 'banana', 'orange', 'strawberry', 'pineapple', 'watermelon', 'avocado', 'burger', 'pizza', 'cake',
  'donut', 'cupcake', 'ice cream', 'bread', 'croissant', 'sushi', 'cookie', 'chocolate bar', 'cheese', 'egg',
  'dog', 'cat', 'horse', 'cow', 'pig', 'sheep', 'rabbit', 'bird', 'parrot', 'owl',
  'duck', 'chicken', 'fish', 'shark', 'dolphin', 'whale', 'turtle', 'frog', 'snake', 'lizard',
  'dinosaur', 'dragon', 'elephant', 'lion', 'tiger', 'bear', 'panda', 'monkey', 'giraffe', 'deer',
  'butterfly', 'bee', 'spider', 'crab', 'octopus', 'person', 'human head', 'face', 'hand', 'skull',
  'cartoon character', 'anime character', 'video game character', 'monster', 'alien', 'superhero', 'knight in armor', 'warrior', 'wizard', 'robot character',
  'sword', 'shield', 'axe', 'hammer', 'wrench', 'screwdriver', 'drill', 'knife', 'gun', 'bow',
  'crown', 'trophy', 'medal', 'coin', 'key', 'lock', 'bell', 'lantern', 'umbrella', 'book',
  'pen', 'pencil', 'scissors', 'ball', 'football', 'basketball', 'tennis racket', 'baseball bat', 'dumbbell', 'chess piece',
  'house', 'building', 'castle', 'tower', 'bridge', 'church', 'temple', 'windmill', 'tent', 'well',
  'rock', 'crystal', 'gemstone', 'shell', 'perfume bottle', 'cosmetic bottle', 'lipstick', 'toothbrush', 'faucet', 'kettle',
  'toaster', 'blender', 'coffee machine', 'microwave', 'fan', 'heater', 'vacuum cleaner', 'washing machine', 'refrigerator', 'oven',
];

const STOP = new Set([
  'img', 'image', 'images', 'photo', 'photos', 'pic', 'picture', 'dsc', 'dscn', 'pxl', 'screenshot', 'screen', 'shot', 'final',
  'copy', 'edited', 'edit', 'untitled', 'download', 'downloads', 'whatsapp', 'jpeg', 'jpg', 'png', 'webp', 'heic', 'file', 'new',
  'scaled', 'large', 'small', 'thumb', 'thumbnail', 'removebg', 'preview', 'min', 'resized', 'crop', 'cropped', 'original', 'hd',
  'front', 'back', 'side', 'view', 'top', 'left', 'right', 'and', 'the', 'of', 'with', 'for', 'a', 'an', 'x', 'at', 'on', 'in', 'am', 'pm',
]);

/** "nike-air-max_90 (2).jpg" -> "nike air max 90"; camera dumps like "IMG_2041.JPG" -> null. */
export function queryFromFilename(name: string): string | null {
  const base = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    // Copy counters: "photo (2)", "photo copy 3".
    .replace(/\(\d+\)/g, ' ')
    .replace(/\bcopy\s*\d*\b/gi, ' ');
  if (/^(img|dsc|dscn|pxl|mvimg|screenshot|screen shot|whatsapp|signal|photo|image)[\s_-]*\d/i.test(base.trim())) return null;
  const words = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !STOP.has(w))
    .filter((w) => !/^\d+$/.test(w) || w.length <= 4)
    .filter((w) => !/^[0-9a-f]{8,}$/.test(w) && !/^\d{6,}/.test(w));
  // Need at least one real word (3+ letters) to be worth searching for.
  if (!words.some((w) => /[a-z]{3,}/.test(w))) return null;
  return words.slice(0, 6).join(' ');
}

export const PROMPT = (label: string) => `a photo of a ${label}`;

/** Top-k labels by softmax over CLIP logits (logit scale 100, as in CLIP). */
export function topLabels(imageVec: Float32Array, labelVecs: Float32Array[], labels: string[], k = 5): { label: string; score: number }[] {
  const logits = labelVecs.map((v) => {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * imageVec[i];
    return s * 100;
  });
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps
    .map((e, i) => ({ label: labels[i], score: e / sum }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
