/**
 * Fuzzy matcher para vincular resultados de email a exam_cards existentes.
 *
 * Estratégia de pontuação (0-100):
 *   pet_name  match → +40pts
 *   exam_type match → +30pts
 *   lab_name  match → +20pts
 *   único card      → +10pts
 *
 * Threshold mínimo: 50 pts para considerar match válido.
 */

// ─── Tipos ──────────────────────────────────────────────────

export interface EmailData {
  pet_name?: string;
  exam_type?: string;
  lab_name?: string;
  arquivo_url?: string;
  received_at?: string;
}

export interface CardCandidate {
  card_id: string;
  pet_name: string | null;
  item_id: string;
  exam_type: string;
  lab_name: string | null;
}

export interface MatchResult {
  card_id: string;
  item_id: string;
  score: number;
  match_type: "exact" | "fuzzy" | "single";
}

// ─── Normalização de texto ──────────────────────────────────

const ACCENT_MAP: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a",
  è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o",
  ù: "u", ú: "u", û: "u", ü: "u",
  ç: "c", ñ: "n",
};

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .split("")
    .map((ch) => ACCENT_MAP[ch] ?? ch)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Fuzzy contains ─────────────────────────────────────────

export function fuzzyContains(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  return h.includes(n) || n.includes(h);
}

// ─── Levenshtein distance (para nomes curtos) ───────────────

export function levenshtein(a: string, b: string): number {
  const an = normalizeText(a);
  const bn = normalizeText(b);

  if (an === bn) return 0;
  if (an.length === 0) return bn.length;
  if (bn.length === 0) return an.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= an.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= bn.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= an.length; i++) {
    for (let j = 1; j <= bn.length; j++) {
      const cost = an[i - 1] === bn[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[an.length][bn.length];
}

// ─── Pontuação de match ─────────────────────────────────────

export function scoreMatch(
  candidate: CardCandidate,
  email: EmailData
): number {
  let score = 0;

  // Pet name matching (+40pts)
  if (email.pet_name && candidate.pet_name) {
    const normEmail = normalizeText(email.pet_name);
    const normCard = normalizeText(candidate.pet_name);

    if (normEmail === normCard) {
      score += 40; // match exato
    } else if (fuzzyContains(normCard, normEmail)) {
      score += 35; // contém
    } else if (levenshtein(normEmail, normCard) <= 2) {
      score += 30; // Levenshtein próximo
    }
  }

  // Exam type matching (+30pts)
  if (email.exam_type && candidate.exam_type) {
    const normEmail = normalizeText(email.exam_type);
    const normCard = normalizeText(candidate.exam_type);

    if (normEmail === normCard) {
      score += 30;
    } else if (fuzzyContains(normCard, normEmail)) {
      score += 25;
    } else if (levenshtein(normEmail, normCard) <= 3) {
      score += 20;
    }
  }

  // Lab name matching (+20pts)
  if (email.lab_name && candidate.lab_name) {
    const normEmail = normalizeText(email.lab_name);
    const normCard = normalizeText(candidate.lab_name);

    if (normEmail === normCard) {
      score += 20;
    } else if (fuzzyContains(normCard, normEmail)) {
      score += 15;
    }
  }

  return score;
}

// ─── Encontrar melhor match ─────────────────────────────────

const MATCH_THRESHOLD = 50;

export function findBestMatch(
  candidates: CardCandidate[],
  email: EmailData
): MatchResult | null {
  if (candidates.length === 0) return null;

  // Se só tem um card aguardando, bônus de +10
  const singleBonus = candidates.length === 1 ? 10 : 0;

  let bestMatch: MatchResult | null = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = scoreMatch(candidate, email) + singleBonus;

    if (score > bestScore) {
      bestScore = score;

      let matchType: MatchResult["match_type"] = "fuzzy";
      if (score >= 90) matchType = "exact";
      else if (candidates.length === 1 && score >= MATCH_THRESHOLD)
        matchType = "single";

      bestMatch = {
        card_id: candidate.card_id,
        item_id: candidate.item_id,
        score,
        match_type: matchType,
      };
    }
  }

  // Só retorna se atingiu threshold
  if (bestMatch && bestMatch.score >= MATCH_THRESHOLD) {
    return bestMatch;
  }

  return null;
}
