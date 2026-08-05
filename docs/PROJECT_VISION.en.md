# THEIA Ultimate Project Purpose

[简体中文](PROJECT_VISION.md) | [English](PROJECT_VISION.en.md)

[Download the bilingual Word edition](THEIA_PROJECT_VISION_BILINGUAL.docx)

## Core Statement

> "THEIA is not software for managing life, nor is it a tool for analyzing chat histories. It is a long-term experiment devoted to studying a single subject, and that subject has always been myself. It seeks to connect memory, behavior, emotion, relationships, decisions, and environment along the axis of time, not to predict the future or judge right and wrong, but to answer, as completely as possible, one question that runs through my life: How did I become who I am today, and who am I becoming?"
>
> — GPT-5.5

This is not marketing copy. It is THEIA's product definition, research boundary, and long-term architectural north star. Tasks, conversations, people, relationships, places, schedules, emotions, memories, and environmental context are all building blocks for a traceable, correctable, user-owned personal timeline.

## Subject and Time Scale

THEIA studies one subject: the user. Other people, groups, schools, workplaces, places, and events enter the system because they form the context in which the user's experience and development occur. THEIA is not intended to build supposedly objective dossiers on other people or pass judgment on them.

The system must support several time scales at once:

- the present: current tasks, emotions, choices, and surroundings;
- a period: habits, relationship changes, and decision paths developing over weeks or months;
- a life course: changes in learning, life, identity, and values across years;
- retrospection: how later evidence revises an earlier understanding.

Time is more than a message timestamp. It includes source time, event time, user-confirmation time, model-inference time, revision time, and the time at which a conclusion becomes obsolete.

## Epistemic Boundary

THEIA does not equate more data with truth, or fluent model output with understanding. The system must distinguish:

1. **Raw observations**: conversations, images, files, places, schedules, or notes deliberately supplied by the user.
2. **Structured facts**: statements with a clear subject and time that can be traced directly to raw observations.
3. **Model inferences**: patterns, tendencies, or interpretations supported by multiple observations but still fallible.
4. **User reflections**: the user's own interpretation, correction, or reservation.
5. **Action choices**: what the user decides to do next, rather than a verdict made by the system.

Every inference must lead back to evidence, expose uncertainty, and remain replaceable by later information. The system should preserve an honest gap instead of inventing connections to make a profile, timeline, or recommendation look complete.

## Design Principles

### 1. Longitudinal first

A single moment rarely describes a person. Prefer change, repetition, continuity, turning points, and exceptions over stable personality labels inferred from one statement.

### 2. Provenance first

Every important conclusion should retain platform, conversation, speaker, direction, quotation, and time. Provenance is not debug metadata; it is a primary interface for understanding and correction.

### 3. Explicit subjects

"You," "the other person," group members, and system inference must stay distinct. Another person's invitation, preference, or decision must never be rewritten as the user's own, and speaker direction must not be guessed from display names.

### 4. Separate facts, inferences, and advice

Facts answer what happened. Inferences answer what the evidence might mean. Advice answers what could be considered next. These layers must not collapse into one falsely certain narrative.

### 5. No prediction, scoring, or judgment

THEIA may help review patterns and understand choices. It must not predict destiny, score relationships or personalities, or present model advice as the only correct answer.

### 6. User sovereignty

Data stays local by default. The user decides what to import, what to send to which model, what to retain, and what to delete. Deletion, export, migration, and rollback must work in practice.

### 7. Revision over final verdicts

Profiles, relationship interpretations, and the meaning assigned to events should evolve with evidence. The system should preserve when and why an interpretation changed instead of silently replacing history with the newest prose.

### 8. Quiet technology

The interface should support observation and recollection. Levels, experience points, focus scores, manipulative engagement mechanics, and meaningless alerts must not turn self-study into another performance system.

## How Current Features Build Toward the Goal

| Current capability | Long-term role |
| --- | --- |
| Conversation import and archive | Establish the raw observation layer with time, subject, and provenance |
| Task candidates and schedule | Identify open loops that may require action or later verification |
| People and relationships | Preserve how others participate in the user's experience without issuing verdicts about them |
| Map and places | Connect experience to real environments and spatial change |
| Task atlas | Show relationships among current open questions, not an efficiency leaderboard |
| Model analysis | Assist compression, linkage, and hypothesis formation while keeping every result reviewable |
| Append-only archive and migrations | Keep a growing timeline readable, recoverable, and durable across versions |
| Logs and protocols | Make model processing reproducible instead of hiding failure behind "AI-generated" output |

## Development Decision Gate

Before entering the core product, a feature must satisfy at least one of these conditions without violating the other principles:

- connect evidence that was previously separated across time;
- clarify the difference between fact, inference, reflection, and action;
- make provenance, correction, or reversal easier for the user;
- make long-term data more reliable, private, portable, or reproducible;
- reveal how change happened rather than merely showing a current state.

If a feature only increases task count, profile length, engagement time, or visual stimulation without improving longitudinal self-understanding, it should not be a core priority.

## Success Criteria

THEIA is not successful because it generates many tasks, reads many messages, or writes long profiles. Better measures are:

- whether a conclusion can be traced back to lived experience;
- whether the system can admit uncertainty and revise itself when new evidence arrives;
- whether years of data remain readable, understandable, and portable;
- whether the user can see continuity, change, and contradiction rather than receive a single label;
- whether the technology clarifies memory and reflection while preserving human complexity and agency.

## Documentation Policy

The project purpose and core developer documentation must be maintained in both Simplified Chinese and English. Chinese is currently the normative source. Changes to product purpose, protocol semantics, security boundaries, or release procedure must update the corresponding English document as part of the same change; machine-translated placeholders are not acceptable.
