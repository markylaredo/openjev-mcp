# This morning's queue: eight messages, one tool call

Eight member messages are waiting at an electric cooperative's help desk. An agent is
asked to triage each one (category and safety hazard) and to produce a dispatch list with
the hazards first. It sends the whole queue as one `jev_batch` call, keyed by ticket id.

| | |
| --- | --- |
| **Agent** | DeepSeek Harness 0.1.5-rc.2, `headless` profile, `deepseek-flash` at maximum reasoning effort |
| **Server** | openjev-mcp 0.1.2 plus `jev_batch` (pre-release build), default settings |
| **Recorded** | 2026-10-12, in an empty working directory |
| **OpenJEV** | 8 requests, one per ticket, 4 in flight at a time · 5,124 in / 598 out tokens · 2.2 s |
| **Whole run** | 28 s |

Copied from the session log. JSON is re-indented, the model's private reasoning is left out, and the malformed attempts the server rejected are described rather than reprinted.

## The task

> Here is this morning's help-desk queue at our electric cooperative. Triage every message with the openjev tools: its category (outage, billing_dispute, meter, new_connection, or other) and whether it describes a safety hazard, such as a downed or sparking line or a burning meter.
>
> Then give me a dispatch list: every ticket with a hazard probability of 0.5 or more first, for the on-call line crew, then the rest grouped by category. Use the ticket ids.
>
> T-2301: "Power's been out on Ridge Road since 6am. Three houses on our side are dark; the other side has lights."
>
> T-2302: "My bill this month is double last month's and we were away for two weeks. Please check it."
>
> T-2303: "There's a line down across our driveway and it's sparking. We're keeping the kids inside."
>
> T-2304: "We're building a house on Lot 14, Cedar Lane and need a new service connection. What do you need from us?"
>
> T-2305: "The meter reader couldn't get in because of our dog. Can I send you a photo of the meter instead?"
>
> T-2306: "The lights flicker every evening around 7pm. Is something wrong with the transformer near the school?"
>
> T-2307: "I paid at the bank on the 3rd but got a disconnection notice today. Please don't cut us off, my mother is on oxygen at home."
>
> T-2308: "Smoke is coming out of the meter box on the side of our house and it smells like burning plastic."

## The call

> I'll triage all eight tickets in one batched Jev call — one category judgment and one hazard judgment per ticket.

The model's first two attempts ended their arguments with a stray closing brace, so they
reached the server without `items` or `questions`. The server's input check rejected
both before anything was sent to OpenJEV:

```
MCP error -32602: Input validation error: Invalid arguments for tool jev_batch: Invalid input: expected array, received undefined at items
Invalid input: expected record, received undefined at questions
```

Between the two attempts, the agent wrote:

> The call got wrapped incorrectly. Retrying with the parameters at the top level.

The third attempt went through. `mcp__openjev__jev_batch`:

```json
{
  "items": [
    {
      "id": "T-2301",
      "state": "Power's been out on Ridge Road since 6am. Three houses on our side are dark; the other side has lights."
    },
    {
      "id": "T-2302",
      "state": "My bill this month is double last month's and we were away for two weeks. Please check it."
    },
    {
      "id": "T-2303",
      "state": "There's a line down across our driveway and it's sparking. We're keeping the kids inside."
    },
    {
      "id": "T-2304",
      "state": "We're building a house on Lot 14, Cedar Lane and need a new service connection. What do you need from us?"
    },
    {
      "id": "T-2305",
      "state": "The meter reader couldn't get in because of our dog. Can I send you a photo of the meter instead?"
    },
    {
      "id": "T-2306",
      "state": "The lights flicker every evening around 7pm. Is something wrong with the transformer near the school?"
    },
    {
      "id": "T-2307",
      "state": "I paid at the bank on the 3rd but got a disconnection notice today. Please don't cut us off, my mother is on oxygen at home."
    },
    {
      "id": "T-2308",
      "state": "Smoke is coming out of the meter box on the side of our house and it smells like burning plastic."
    }
  ],
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Classify this electric-cooperative help-desk message into exactly one category, based on what the customer is actually asking for.",
      "criteria": {
        "outage": "Reports power loss or lights out at one or more premises, or asks when power will be restored.",
        "billing_dispute": "Questions, disputes, or asks for review of a charge, bill amount, payment, or a disconnection/shutoff notice.",
        "meter": "Concerns the meter itself: reading it, accessing it, a photo of it, or meter equipment condition.",
        "new_connection": "Requests new service, a new service connection, or construction/line extension for a property.",
        "other": "None of the above categories fits the message's main request."
      }
    },
    "hazard": {
      "type": "noul",
      "instructions": "Does this message report a physical safety hazard that warrants an emergency line-crew response — for example a downed or sparking power line, a burning or smoking meter, or fire/smoke at electrical equipment? Answer yes only if the message itself describes such a physical hazard. Do not answer yes for a plain outage, flickering lights, a billing problem, or a request for information.",
      "criteria": {
        "true": "The message describes an active physical hazard such as a downed/sparking line, or a burning, smoking, or arcing meter or electrical equipment.",
        "false": "The message describes only an inconvenience or a routine service request, with no physical hazard reported."
      }
    }
  }
}
```

## The result

```json
{
  "counts": {
    "total": 8,
    "answered": 8,
    "failed": 0,
    "not_sent": 0
  },
  "answers": {
    "T-2301": {
      "category": {
        "type": "choice",
        "choice": "outage",
        "probabilities": {
          "outage": 1,
          "billing_dispute": 0,
          "meter": 0,
          "new_connection": 0,
          "other": 0
        },
        "confidence": 1
      },
      "hazard": {
        "type": "noul",
        "noul": 0.03
      }
    },
    "T-2302": {
      "category": {
        "type": "choice",
        "choice": "billing_dispute",
        "probabilities": {
          "outage": 0,
          "billing_dispute": 1,
          "meter": 0,
          "new_connection": 0,
          "other": 0
        },
        "confidence": 1
      },
      "hazard": {
        "type": "noul",
        "noul": 0.01
      }
    },
    "T-2303": {
      "category": {
        "type": "choice",
        "choice": "other",
        "probabilities": {
          "outage": 0.01,
          "billing_dispute": 0,
          "meter": 0,
          "new_connection": 0,
          "other": 0.99
        },
        "confidence": 0.99
      },
      "hazard": {
        "type": "noul",
        "noul": 0.98
      }
    },
    "T-2304": {
      "category": {
        "type": "choice",
        "choice": "new_connection",
        "probabilities": {
          "outage": 0,
          "billing_dispute": 0,
          "meter": 0,
          "new_connection": 1,
          "other": 0
        },
        "confidence": 1
      },
      "hazard": {
        "type": "noul",
        "noul": 0.01
      }
    },
    "T-2305": {
      "category": {
        "type": "choice",
        "choice": "meter",
        "probabilities": {
          "outage": 0,
          "billing_dispute": 0,
          "meter": 1,
          "new_connection": 0,
          "other": 0
        },
        "confidence": 1
      },
      "hazard": {
        "type": "noul",
        "noul": 0.01
      }
    },
    "T-2306": {
      "category": {
        "type": "choice",
        "choice": "other",
        "probabilities": {
          "outage": 0.32,
          "billing_dispute": 0,
          "meter": 0,
          "new_connection": 0,
          "other": 0.68
        },
        "confidence": 0.6
      },
      "hazard": {
        "type": "noul",
        "noul": 0.02
      }
    },
    "T-2307": {
      "category": {
        "type": "choice",
        "choice": "billing_dispute",
        "probabilities": {
          "outage": 0,
          "billing_dispute": 1,
          "meter": 0,
          "new_connection": 0,
          "other": 0
        },
        "confidence": 1
      },
      "hazard": {
        "type": "noul",
        "noul": 0.01
      }
    },
    "T-2308": {
      "category": {
        "type": "choice",
        "choice": "meter",
        "probabilities": {
          "outage": 0,
          "billing_dispute": 0,
          "meter": 0.79,
          "new_connection": 0,
          "other": 0.21
        },
        "confidence": 0.74
      },
      "hazard": {
        "type": "noul",
        "noul": 0.98
      }
    }
  },
  "model": "openjev",
  "usage": {
    "input_tokens": 5124,
    "output_tokens": 598
  }
}
```

## The agent's answer

> All eight tickets triaged — 8/8 answered, no failures. Two came back as hazards at 0.98.
>
> ## Triage results
>
> | Ticket | Category | P(hazard) | Note |
> |---|---|---|---|
> | T-2301 | outage (1.00) | 0.03 | |
> | T-2302 | billing_dispute (1.00) | 0.01 | |
> | T-2303 | **other** (0.99) | **0.98** | Downed, sparking line |
> | T-2304 | new_connection (1.00) | 0.01 | |
> | T-2305 | meter (1.00) | 0.01 | |
> | T-2306 | other (0.68) / outage (0.32) | 0.02 | Low confidence, 0.60 — see flag below |
> | T-2307 | billing_dispute (1.00) | 0.01 | Medical-vulnerability flag — see below |
> | T-2308 | meter (0.79) / other (0.21) | **0.98** | Burning meter box |
>
> ## Dispatch list
>
> **⚠️ On-call line crew — hazard P ≥ 0.5 (dispatch immediately)**
> 1. **T-2303** — line down across driveway, sparking; children being kept inside. *P = 0.98*
> 2. **T-2308** — smoke from meter box, burning-plastic smell. *P = 0.98*
>
> **Remaining tickets, by category**
>
> - **outage**
>   - T-2301 — Ridge Road, three houses dark since 6am (other side has lights)
> - **billing_dispute**
>   - T-2302 — bill double last month's, two weeks away
>   - T-2307 — paid at bank on the 3rd, disconnection notice received *(escalate — see below)*
> - **meter**
>   - T-2305 — meter-reader access blocked by dog; customer offers a photo
> - **new_connection**
>   - T-2304 — new service connection, Lot 14 Cedar Lane
> - **other**
>   - T-2306 — lights flicker ~7pm; asks about transformer near the school *(classify by hand — see below)*
>
> ## Two flags for a human
>
> - **T-2307 is not a line-crew hazard, but it is time-critical.** The customer reports a disconnection notice despite a payment and a household member on oxygen. That is a life-safety dependency on service continuity, so it should go to a billing supervisor today rather than the routine billing queue — Jev scored only the *physical* hazard question, and a correct 0.01 there does not mean low urgency.
> - **T-2306's category is genuinely uncertain.** The choice distribution was 0.68 "other" / 0.32 "outage" (confidence 0.60), because flickering lights sit between a power-quality complaint and an outage. Its hazard probability is a confident 0.02, so it is not a crew emergency, but I'd have a dispatcher assign the category by hand — it may need a voltage/transformer check rather than a routine ticket.
>
> One caveat on method: the hazard probabilities are the model's judgments on the text alone, and I took them at face value. Both positives are unambiguous in wording, so the ≥ 0.5 cut is safe here, but nothing in the queue was verified against outage or SCADA records.

## What to notice

- **One tool call for the queue, keyed by ticket id.** The agent gave each item its
  ticket number as `id`, so every answer, and the dispatch list built from them, maps
  straight back to a ticket.
- **The batch pays per ticket.** 8 requests at about 640 input tokens each,
  since each request carries the questions. A batch saves the agent turns and paces the
  requests; it does not make them cheaper.
- **Hazard is independent of category.** The two dispatches, a sparking line and a
  burning meter box, came from different categories and both scored 0.98.
- **The option descriptions decide the label.** The agent's `outage` option said "power
  loss or lights out", so a sparking line with no reported loss of power was filed as
  `other` (0.99). Jev followed the definition it was given; the option descriptions are
  where a desk tunes this.
- **A split distribution went to a person.** T-2306 came back 0.68 `other` / 0.32
  `outage` (confidence 0.60), and the agent asked for a dispatcher to file it by hand.
- **The number was not stretched to fit.** T-2307, a disconnection notice in a home where
  someone is on oxygen, scored 0.01 on the physical-hazard question, which is correct. The
  agent raised it as time-critical in its own words instead of reading the hazard score as
  urgency.
