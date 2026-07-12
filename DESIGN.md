Ongoing design Log

## V1: Initial Slack Bot + Sql Tooling

### Slackbot authenticating requests
- I'm opting to host this slack bot locally, rather than kick it up into a server. As a result, the server will connect to slack via a websocket, using Socket mode. This allows us to avoid exposing a public HTTP endpoint.
- We'll maintain the `SLACK_APP_TOKEN`, which is used to open up the websocket (bolt will use it to create the connection) and the `SLACK_BOT_TOKEN` (which scopes the bot's permissions, and used to write events to slack) in our .env file.
- In a later stage, I'll explore opening up a webhook + will demonstrate what that would look like.


### SQL tool structure
Eventually, we'll want our slackbot to choose amongst a collection of tools.

For this V1, we'll focus on SQL search, but I'd like to eventually expand this to include semantic search (via vector db). Plain SQL queries are also a little brute-forcey, and won't have relevance scoring (potentially leading to context bloat) so I'll want to look into BM25 and a more optimized search architecture later too.

It's a big security risk to allow an llm to execute any SQL query that it wants. It's usually best to have specific tools that the agent is allowed to pass parameters into (filter, table name, etc). 

But first, I'm curious about how the agent performs with entirely free-reigns on 



## v0: EVALS - outlining an initial eval suite to inform performance
There are a million directions you can take agent building. I want to make sure that I'm not just blindly making shots in the dark during the building process. 

So before I begin, I'd like to first define some ground truth samples. As we iterate this agent, I'll be running these evals, and storing them. This will help me make informed decisions while I incrementally improve this system.

### What evals do we care about? 
Answer Evals: 
- End-to-end quality (A|Q)
- Faithfulness (A|C) - useful for hallucination calculation

Note: since these are multi-turn conversations, the Q will sometimes be one-shot questions; other times, it'll be a compacted history + an ambiguous user query ("tell me more about THAT").

Searching Evals (digging into the quality of the context our agent retrieves):
- Context relevance (C|Q)
- recall@K (gaps) & precision@k (noise)
- Maybe MRR@K / MAP@K

Performance Evals: 
- How many tools did the agent use? 
- How many loops did the agent do? 
- How often does the agent trigger the hard loop-cap? 

(Later on): Trajectory Evals:
- Which tools did the agent call? In what order? 

Data sets: 
- Golden set (hand curated by me ~40 query and answer samples, intended to stress test the system)
- Adversarial set to test malicious inputs, intended failure

### Creating the golden set
I'll start by taxonomizing the user access patterns, and annotate different fields to pass into an LLM

#### User query behaviors (request_type):
- Summaries (summarize these events)
- Simple episodic recall (what happened on xyz date)
- Single entity analysis (for this specific xyz, please tell me your read)
- Multi-entity analysis (which companies experienced abc pain ponts? Which ones are most likely to churn)
- Multi-turn queries (earlier in the conversation, we talked about xyz company; latest user message now just says "Tell me about their business model")

#### Query patterns (query_type):
Detailing some possible query patterns that we can expect. This behavior pattern will inform both our synthetic eval generation and our tooling. 

Simple queries (directly queryable with sql filters like WHERE, LIKE)
    - Questions about specific entities in a specific table (employees, products, scenarios, customers...) (How many employees does Maple River Regional Bank have?)
    - Questions that address time frames ("What were my customer calls yesterday")

Semantic queries (Driven on meaning)
    - Queries driven based on meaning (ie: "what are the most common pain points that customers experience?", "give me the most challenging sales calls we've had so far"): traditional sql will be inadequate for these queries
    - Starting out, I expect a lot of semantic queries to fail with purely sql tooling (or a lot of extraneous queries / context bloat).

Complex queries: 
    - Multi-step queries: Questions that will require multiple sql searches ("Out of all customers > 500 employees based in California, could you summarize the conversations we've had with each one over the past three weeks where there was obvious FUD?")
    - Multi-turn queries (Could you summarize the conversations we've had with John at xyz company? Are there any others that share the same concerns? What are some gaps in our product that aren't highlighted yet?)

#### Synthetic eval dimensions (to generate queries): 
- query_type (summary, episodic, numeric, single_entity_analysis, multi_entity_analysis)
- entities (customers, competitors, company, products, employees, implementations, products, scenarios)
- history (single_message, multi_turn)
- should_have_response (answerable, unanswerable, refusal)
- response_type (discrete, free-form): useful to inform deterministic vs subjective eval; we should have mostly discrete response_types, with <5 free-form response types in our data set (to reduce initial human friction). This can be scaled with an LLM as a judge later.

Purpose of evals: 
- RAG evals: Ensure that context shared with agent is constrained (avoid context bloat)
- Performance Evals: Ensure that the question is answered with a reasonable amount of accuracy
    - Some have deterministic criteria (numeric queries, episodic queries, listing specific companies/transcripts with xyz criteria)
    - Some have non-deterministic criteria (summaries, free-form analysis)
    
The former can have deterministic answers in our dataset. The latter will require manual human review.

### How should I generate the adversarial data set?
Test against potential failure modes: 
- Misspelling (fuzzy matching)
- Injection
    - Naive prompt injection
    - Disguised prompt injection
- Irrelevance (Kanye west's birthday...)
