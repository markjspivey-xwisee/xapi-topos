// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-wallet  —  recommendations.ts
//
// Learning recommendations engine.
// Analyzes your DNA (competency graph) and suggests what to learn next.
// ─────────────────────────────────────────────────────────────────────────────

export interface Recommendation {
  type: "gap" | "extension" | "progression";
  activity: string;
  activityName: string;
  reason: string;
  confidence: number;
  relatedMastered: string[];
  currentGrade?: string;
  targetGrade: string;
}

export interface LearningStatement {
  id?: string;
  verb?: { id: string };
  object?: { id?: string; definition?: { name?: Record<string, string> } };
  result?: { completion?: boolean; score?: { scaled?: number } };
  timestamp?: string;
}

export function generateRecommendations(
  statements: LearningStatement[],
  maxRecommendations: number = 10,
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // Build activity model
  const activityMap = new Map<string, {
    id: string; name: string; attempts: number;
    bestScore: number; completed: boolean; verbs: Set<string>;
  }>();

  for (const stmt of statements) {
    const actId = stmt.object?.id || "unknown";
    const actName = stmt.object?.definition?.name?.["en-US"]
      || stmt.object?.definition?.name?.en
      || actId.split("/").pop() || "Activity";
    const verb = stmt.verb?.id?.split("/").pop() || "unknown";
    const score = stmt.result?.score?.scaled;
    const completed = stmt.result?.completion === true;

    if (!activityMap.has(actId)) {
      activityMap.set(actId, { id: actId, name: actName, attempts: 0, bestScore: 0, completed: false, verbs: new Set() });
    }

    const a = activityMap.get(actId)!;
    a.attempts++;
    a.verbs.add(verb);
    if (score !== undefined && score > a.bestScore) a.bestScore = score;
    if (completed) a.completed = true;
  }

  const activities = [...activityMap.values()];
  const mastered = activities.filter(a => a.completed && a.bestScore >= 0.9);
  const proficient = activities.filter(a => a.completed && a.bestScore >= 0.7 && a.bestScore < 0.9);
  const attempted = activities.filter(a => !a.completed || a.bestScore < 0.7);

  // GAPS
  for (const a of attempted.sort((x, y) => y.bestScore - x.bestScore)) {
    recommendations.push({
      type: "gap",
      activity: a.id,
      activityName: a.name,
      reason: a.bestScore > 0
        ? `You scored ${(a.bestScore * 100).toFixed(0)}% — ${((0.9 - a.bestScore) * 100).toFixed(0)}% more to master`
        : `Attempted ${a.attempts} time(s) but not completed`,
      confidence: 0.9 - (a.bestScore * 0.3),
      relatedMastered: mastered.filter(m => shareTokens(m.name, a.name)).map(m => m.name),
      currentGrade: a.completed ? "proficient" : "attempted",
      targetGrade: "mastered",
    });
  }

  // PROGRESSIONS
  for (const a of proficient.sort((x, y) => y.bestScore - x.bestScore)) {
    recommendations.push({
      type: "progression",
      activity: a.id,
      activityName: a.name,
      reason: `Proficient at ${(a.bestScore * 100).toFixed(0)}% — push for mastery`,
      confidence: 0.8,
      relatedMastered: mastered.filter(m => shareTokens(m.name, a.name)).map(m => m.name),
      currentGrade: "proficient",
      targetGrade: "mastered",
    });
  }

  // EXTENSIONS
  const domains = new Map<string, number>();
  for (const m of mastered) {
    const domain = extractDomain(m.name);
    domains.set(domain, (domains.get(domain) || 0) + 1);
  }
  for (const [domain, count] of [...domains.entries()].sort((a, b) => b[1] - a[1])) {
    if (count >= 2) {
      recommendations.push({
        type: "extension",
        activity: `urn:hela:recommended:${domain}-advanced`,
        activityName: `Advanced ${domain}`,
        reason: `You've mastered ${count} activities in ${domain} — explore advanced topics`,
        confidence: 0.6 + (count * 0.05),
        relatedMastered: mastered.filter(m => extractDomain(m.name) === domain).map(m => m.name),
        targetGrade: "proficient",
      });
    }
  }

  return recommendations.sort((a, b) => b.confidence - a.confidence).slice(0, maxRecommendations);
}

function tokenize(name: string): string[] {
  return name.toLowerCase().split(/[\s\-_\/]+/).filter(t => t.length > 2);
}

function shareTokens(a: string, b: string): boolean {
  const ta = new Set(tokenize(a));
  return tokenize(b).some(t => ta.has(t));
}

function extractDomain(name: string): string {
  const stops = new Set(["the", "and", "for", "with", "module", "course", "lesson", "unit", "section", "part", "activity"]);
  const tokens = tokenize(name).filter(t => !stops.has(t));
  return tokens.sort((a, b) => b.length - a.length)[0] || tokenize(name)[0] || "general";
}
