// ─────────────────────────────────────────────────────────────────────────────
// @foxxi/hela-store  —  profiles.ts
//
// xAPI Profiles as Grothendieck topologies J on the site 𝒞_xAPI.
//
// A Profile J specifies which sieves are "covering" — i.e. which statement
// patterns constitute valid evidence under that profile.
//
// Conformance = ψ is a sheaf under J:
//   a_J(ψ) = ψ   iff   ψ ∈ Sh(𝒞_xAPI, J)
//
// Non-conformant statements don't exist as global sections under J.
// The topology IS the filter — not a runtime validator bolted on.
// ─────────────────────────────────────────────────────────────────────────────

import {
  IRI, Profile, ProfileConcept, StatementTemplate, TemplateRule,
  StoredXAPIStatement, ProfileValidationResult, Activity,
} from "./types";

// ── HELA Curriculum Profile ───────────────────────────────────────────────────
// A sample Profile for the HELA curriculum vertical.
// Defines valid verbs, activity types, and statement templates.
export function buildProfile(): Profile {
  const id = IRI("https://profiles.hela.foxxi.io/hela-curriculum/v1");

  const concepts: ProfileConcept[] = [
    { id: IRI("http://adlnet.gov/expapi/verbs/completed"),   type: "Verb",         inScheme: id },
    { id: IRI("http://adlnet.gov/expapi/verbs/passed"),      type: "Verb",         inScheme: id },
    { id: IRI("http://adlnet.gov/expapi/verbs/failed"),      type: "Verb",         inScheme: id },
    { id: IRI("http://adlnet.gov/expapi/verbs/attempted"),   type: "Verb",         inScheme: id },
    { id: IRI("http://adlnet.gov/expapi/verbs/progressed"),  type: "Verb",         inScheme: id },
    { id: IRI("http://adlnet.gov/expapi/activities/course"), type: "ActivityType", inScheme: id },
    { id: IRI("http://adlnet.gov/expapi/activities/module"), type: "ActivityType", inScheme: id },
  ];

  // Template: completed course
  const completionTemplate: StatementTemplate = {
    id:   IRI(`${id}/templates/completion`),
    verb: IRI("http://adlnet.gov/expapi/verbs/completed"),
    objectActivityType: IRI("http://adlnet.gov/expapi/activities/course"),
    rules: [
      {
        location:  "$.result.completion",
        presence:  "included",
      },
      {
        location:  "$.result.score.scaled",
        presence:  "recommended",
      },
      {
        location:  "$.object.definition.type",
        presence:  "included",
        any:       [IRI("http://adlnet.gov/expapi/activities/course")],
      },
    ],
  };

  // Template: generic verb
  const genericTemplate: StatementTemplate = {
    id:   IRI(`${id}/templates/generic`),
    rules: [
      {
        location:  "$.actor",
        presence:  "included",
      },
      {
        location:  "$.verb.id",
        presence:  "included",
      },
      {
        location:  "$.object.id",
        presence:  "included",
      },
    ],
  };

  const templates = [completionTemplate, genericTemplate];

  // The validate function IS the topology.
  // It evaluates whether ψ is a sheaf under J_hela-curriculum.
  const validate = (stmt: StoredXAPIStatement): ProfileValidationResult => {
    const errors: string[] = [];

    // Find the matching template(s)
    const matchingTemplate = templates.find(t => {
      if (t.verb && t.verb !== stmt.verb.id) return false;
      if (t.objectActivityType) {
        const def = ("definition" in stmt.object) ? stmt.object.definition : undefined;
        if (!def?.type || def.type !== t.objectActivityType) return false;
      }
      return true;
    }) ?? genericTemplate;

    // Evaluate each rule in the matching template
    for (const rule of matchingTemplate.rules) {
      const value = resolveJsonPath(stmt, rule.location);

      if (rule.presence === "included" && value === undefined) {
        errors.push(`${rule.location} is required by template ${matchingTemplate.id} but absent`);
      }

      if (rule.presence === "excluded" && value !== undefined) {
        errors.push(`${rule.location} must not be present per template ${matchingTemplate.id}`);
      }

      if (rule.any && value !== undefined && !rule.any.includes(value as IRI)) {
        errors.push(`${rule.location} must be one of [${rule.any.join(", ")}]`);
      }

      if (rule.all && value !== undefined) {
        for (const required of rule.all) {
          const arr = Array.isArray(value) ? value : [value];
          if (!arr.includes(required)) {
            errors.push(`${rule.location} must include ${required}`);
          }
        }
      }

      if (rule.none && value !== undefined) {
        const forbidden = rule.none;
        const arr = Array.isArray(value) ? value : [value];
        for (const f of forbidden) {
          if (arr.includes(f)) {
            errors.push(`${rule.location} must not include ${f}`);
          }
        }
      }
    }

    const conformant = errors.length === 0;

    return {
      conformant,
      templateId: matchingTemplate.id,
      errors,
      // isSheaf: a_J(ψ) = ψ iff the statement satisfies all covering sieves
      // In practice: conformant = isSheaf for this topology
      isSheaf: conformant,
    };
  };

  return { id, version: "1.0.0", concepts, templates, validate };
}

// ── Simple JSONPath resolver (subset sufficient for xAPI rules) ───────────────
function resolveJsonPath(obj: unknown, path: string): unknown {
  // Remove leading $. and split
  const parts = path.replace(/^\$\./, "").split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

// ── Profile registry ──────────────────────────────────────────────────────────
// Maps profile IRI → topology function
// In production this would load from profile URIs (JSON-LD)
export const KNOWN_PROFILES: Record<string, () => Profile> = {
  "https://profiles.hela.foxxi.io/hela-curriculum/v1": buildProfile,
};

// ── Load profile from remote JSON-LD URL ────────────────────────────────────
// Fetches an xAPI Profile (JSON-LD) from a URL and parses it into a Profile object.
// The profile JSON-LD must follow the xAPI Profile spec:
//   https://github.com/adlnet/xapi-profiles
export async function loadProfileFromURL(url: string): Promise<Profile> {
  const res = await fetch(url, {
    headers: { "Accept": "application/ld+json, application/json" },
  });
  if (!res.ok) throw new Error(`Failed to fetch profile from ${url}: HTTP ${res.status}`);

  const raw = await res.json() as any;

  // Extract the profile metadata
  const profileId = IRI(raw.id ?? raw["@id"] ?? url);
  const version = raw.prefLabel?.en ?? raw.versions?.[0]?.id ?? "unknown";

  // Parse concepts
  const concepts: ProfileConcept[] = [];
  for (const c of raw.concepts ?? []) {
    concepts.push({
      id: IRI(c.id ?? c["@id"]),
      type: c.type ?? c["@type"] ?? "Verb",
      inScheme: profileId,
    });
  }

  // Parse statement templates
  const templates: StatementTemplate[] = [];
  for (const t of raw.templates ?? []) {
    const rules: TemplateRule[] = [];
    for (const r of t.rules ?? []) {
      rules.push({
        location: r.location,
        presence: r.presence,
        any: r.any,
        all: r.all,
        none: r.none,
      });
    }
    templates.push({
      id: IRI(t.id ?? t["@id"]),
      verb: t.verb ? IRI(t.verb) : undefined,
      objectActivityType: t.objectActivityType ? IRI(t.objectActivityType) : undefined,
      rules,
    });
  }

  // If no templates were found, create a generic one
  if (templates.length === 0) {
    templates.push({
      id: IRI(`${profileId}/templates/generic`),
      rules: [
        { location: "$.actor", presence: "included" },
        { location: "$.verb.id", presence: "included" },
        { location: "$.object.id", presence: "included" },
      ],
    });
  }

  // Build the validate function (topology)
  const validate = (stmt: StoredXAPIStatement): ProfileValidationResult => {
    const errors: string[] = [];

    const matchingTemplate = templates.find(t => {
      if (t.verb && t.verb !== stmt.verb.id) return false;
      if (t.objectActivityType) {
        const def = ("definition" in stmt.object) ? (stmt.object as any).definition : undefined;
        if (!def?.type || def.type !== t.objectActivityType) return false;
      }
      return true;
    }) ?? templates[templates.length - 1];

    for (const rule of matchingTemplate.rules) {
      const value = resolveJsonPath(stmt, rule.location);
      if (rule.presence === "included" && value === undefined) {
        errors.push(`${rule.location} is required by template ${matchingTemplate.id} but absent`);
      }
      if (rule.presence === "excluded" && value !== undefined) {
        errors.push(`${rule.location} must not be present per template ${matchingTemplate.id}`);
      }
      if (rule.any && value !== undefined && !rule.any.includes(value as IRI)) {
        errors.push(`${rule.location} must be one of [${rule.any.join(", ")}]`);
      }
    }

    const conformant = errors.length === 0;
    return { conformant, templateId: matchingTemplate.id, errors, isSheaf: conformant };
  };

  return { id: profileId, version, concepts, templates, validate };
}
