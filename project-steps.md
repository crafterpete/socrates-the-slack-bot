Project planning 
- v0: evaluation criteria set
- v1: slack bot --> auth --> given sql tools for search based on some context (keyword search, filter, parse)
    - Single slack messages
    - Ack + updates? 
    - Evaluate performance & document eval history
- v2: expand to vector search + evaluate performance
- v3: compaction + memory management (multi-turn convo)
    - Conversation memory (compacted over time)
    - User preferences
- v4: security concerns (malicious injections, multiple adversarial behaviors)
    - HMAC validation? 3 second ack?
    - DB auth / tool auth? 
    - Injection guardrails
- v5: live human feedback + data set expansion/updates 
    - Humans can reply thumbs up and thumbs down
    - Output gets saved in a database
- v6: (subject to change): llm as a judge for evals
    - deterministic checks stay handrolled (retrieval recall@k/precision@k/MRR; answer exact/numeric/set/boolean/abstain markers) --> no API, reproducible, runs every pass
    - offload judge checks to this stage (free-form summaries, faithfulness/groundedness, trajectory) --> lean on openevals + agentevals instead of handrolling judge prompts + parsers


Things to consider
- Eval suite (NOT DONE)
    - Multi-turn: is the query the user input vs user input + compacted memory vs user input + entire memory
    - Human feedback (thumbs up vs thumbs down) for data set
- Security, guardrails, and malicious inputs (NOT DONE)
- Authentication and authorization:
    - Messages should be constrained to user xyz & same with convo history
- Searching mechanism (NOT DONE)
    - Vector vs BM25 vs hybrid
    - Agency level (deterministic pipeline vs agent-defined parameters w/ predefined tools vs more open-ended agent querying)
- Memory management
    - Entire history vs compaction + recent history vs longer term memories (episodic; running log & pointers)
- Decide how to handle slack threads (entire thread history is included? or compacted?)