# One member complaint, four judgments, one call

A member messages an electric cooperative's help desk at 6:42 am. An agent is asked for
four judgments about it (category, urgency, safety hazard, and how upset the member is)
and for a routing decision under the co-op's own thresholds. It gets all four from one
`jev_ask` call.

| | |
| --- | --- |
| **Agent** | DeepSeek Harness 0.1.5-rc.2, `headless` profile, `deepseek-flash` at maximum reasoning effort |
| **Server** | openjev-mcp 0.1.2 plus `jev_batch` (pre-release build), default settings |
| **Recorded** | 2026-10-12, in an empty working directory |
| **OpenJEV** | 1 request · 958 in / 103 out tokens · 0.9 s |
| **Whole run** | 21 s |

Copied from the session log. JSON is re-indented, the model's private reasoning is left out, and the malformed attempt the server rejected is described rather than reprinted.

## The task

> You're helping the help desk of an electric cooperative. Triage the member message below with the openjev tools. We need four things: the category (outage, billing_dispute, meter, new_connection, or other), how urgent it is on a three-level scale (routine, same day, emergency), whether it describes a safety hazard such as a downed or sparking line, and how upset the member is.
>
> Then route it under our policy: a hazard probability of 0.5 or more goes straight to the on-call line crew. Otherwise it goes to the queue for its category, flagged same-day if the urgency score is 1.5 or higher.
>
> Ticket T-2207, received 6:42 am:
>
> "Our power has been going on and off since the storm last night, and now a wire is hanging low over the road in front of our house. It's touching the mango tree and sparks when the wind blows. Kids walk past here to school. This is the third time this month and nobody came the last two times!"

The task names each judgment in a few words and sets the thresholds. It does not say how
to word the questions or which tool to use.

## The call

The model's first attempt ended its arguments with a stray closing brace, so the call
reached the server without a usable `state` or any `questions`. The server's input
check rejected it before anything was sent to OpenJEV:

```
MCP error -32602: Input validation error: Invalid arguments for tool jev_ask: Invalid input at state
Invalid input: expected record, received undefined at questions
```

The agent sent the call again, and it went through. `mcp__openjev__jev_ask`:

```json
{
  "state": {
    "ticket_id": "T-2207",
    "received": "6:42 am",
    "channel": "member message to electric cooperative help desk",
    "message": "Our power has been going on and off since the storm last night, and now a wire is hanging low over the road in front of our house. It's touching the mango tree and sparks when the wind blows. Kids walk past here to school. This is the third time this month and nobody came the last two times!"
  },
  "questions": {
    "category": {
      "type": "choice",
      "instructions": "Which single category best describes what this member message is primarily about, from the cooperative's point of view?",
      "criteria": {
        "outage": "Loss or interruption of electric supply, including storm-related, intermittent, partial, or repeated outages, and reports of damaged or downed service lines causing loss of power.",
        "billing_dispute": "Disagreement or question about charges, invoices, payment, refunds, deposits, fees, or the amount owed.",
        "meter": "The meter itself: faulty, damaged, or malfunctioning meter, inaccurate reads, meter access, or meter tampering.",
        "new_connection": "Request to establish new service, a new connection, reconnect after move, service upgrade, or transfer of service to a new address.",
        "other": "None of the above; the message's primary subject does not fit the categories above."
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this ticket — how quickly does it need action from the cooperative?",
      "criteria": [
        "Routine: no time pressure; can be handled in the normal queue over the coming days.",
        "Same day: should be handled today, but there is no immediate danger to people or property.",
        "Emergency: immediate danger to life or property or an active hazard; requires immediate response right now."
      ]
    },
    "hazard": {
      "type": "noul",
      "instructions": "Does the message describe a safety hazard involving electric lines or equipment, such as a downed, low-hanging, or sparking line, a wire touching a tree or structure, or a line near where people walk?",
      "criteria": {
        "true": "The message describes a safety hazard such as a downed, low-hanging, arcing, or sparking electric line, or a line touching a tree or otherwise exposed to the public.",
        "false": "The message describes no such line or equipment hazard; any problem mentioned is not a physical electrical danger to people or property."
      }
    },
    "upset": {
      "type": "score",
      "instructions": "How upset is the member? Rate the emotional tone and strength of complaint in the message.",
      "criteria": [
        "Not upset: neutral, matter-of-fact tone; no complaint or frustration expressed.",
        "Mildly frustrated: mild annoyance or impatience, but calm and cooperative in tone.",
        "Moderately upset: clear dissatisfaction or complaint about the cooperative's service, with some strong feeling expressed.",
        "Very upset: angry or highly distressed; strong language, repeated failure, demands, or alarm about safety."
      ]
    }
  }
}
```

Every option description, scale level, and the hazard definition is the agent's own.

## The result

```json
{
  "answers": {
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
    "urgency": {
      "type": "score",
      "score": 2,
      "legend": {
        "0": "Routine: no time pressure; can be handled in the normal queue over the coming days.",
        "1": "Same day: should be handled today, but there is no immediate danger to people or property.",
        "2": "Emergency: immediate danger to life or property or an active hazard; requires immediate response right now."
      },
      "probabilities": {
        "0": 0,
        "1": 0,
        "2": 1
      },
      "confidence": 1
    },
    "hazard": {
      "type": "noul",
      "noul": 0.99
    },
    "upset": {
      "type": "score",
      "score": 3,
      "legend": {
        "0": "Not upset: neutral, matter-of-fact tone; no complaint or frustration expressed.",
        "1": "Mildly frustrated: mild annoyance or impatience, but calm and cooperative in tone.",
        "2": "Moderately upset: clear dissatisfaction or complaint about the cooperative's service, with some strong feeling expressed.",
        "3": "Very upset: angry or highly distressed; strong language, repeated failure, demands, or alarm about safety."
      },
      "probabilities": {
        "0": 0,
        "1": 0,
        "2": 0,
        "3": 1
      },
      "confidence": 1
    }
  },
  "model": "openjev",
  "usage": {
    "input_tokens": 958,
    "output_tokens": 103
  }
}
```

## The agent's answer

> Triage complete — one `jev_ask` call carried all four judgments against the ticket text.
>
> ## T-2207 — Triage result
>
> | Question | Answer | Detail |
> |---|---|---|
> | **Category** | `outage` | P(outage) = 1.00, confidence 1.00 (no mass on billing/meter/new_connection/other) |
> | **Urgency** | **2 / 2 — emergency** | P(emergency) = 1.00, confidence 1.00 |
> | **Safety hazard** | **Yes — hazard** | noul = **0.99** (low-hanging wire over the road, touching the mango tree, sparking in wind, on a children's school route) |
> | **Member upset** | **3 / 3 — very upset** | P(level 3) = 1.00, confidence 1.00 ("third time this month and nobody came the last two times") |
>
> ## Routing decision
>
> Policy applied:
>
> - Hazard probability 0.99 ≥ 0.50 → **route to the on-call line crew, immediately.** The "otherwise" branch (category queue + same-day flag at urgency ≥ 1.5) does not apply, since this ticket meets the hazard threshold.
> - For the record, both queue-branch triggers would also have fired (urgency 2.0 ≥ 1.5, category `outage`), so there is no borderline call either way — the two rules agree on today.
>
> **Disposition: escalate to on-call line crew now — treat as an energized-line hazard.** Supporting detail for the crew: wire down/low over the roadway, arcing against a mango tree in wind, pedestrian route used by schoolchildren, and a repeat report (third this month, two prior visits apparently not completed). Recommend the dispatcher also note the missed-response history for the follow-up callback to the member.

## What to notice

- **One request, four typed answers.** The four judgments share one state, so they went
  in one `jev_ask` call: one request, one latency, 958 input tokens for all four.
- **The thresholds stayed with the co-op.** Jev returned a category, a hazard
  probability, and positions on two scales. The 0.5 hazard and 1.5 urgency cut-offs came
  from the task, and the agent applied them as written.
- **The option descriptions decided the label.** The agent's `outage` option covered
  "damaged or downed service lines causing loss of power", so a sparking wire after an
  intermittent outage was filed as `outage` at 1.00. In
  [the queue example](../coop-queue/transcript.md), an `outage` option that said only
  "power loss or lights out" sent a sparking line to `other`.
- **The agent added what the numbers cannot carry.** The member's repeat-contact history
  ("nobody came the last two times") went into the dispatch note for a follow-up
  callback, in the agent's words rather than as a Jev answer.
