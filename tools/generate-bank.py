#!/usr/bin/env python3
"""Generate the Model Match answer bank with the Pollinations API.

Usage:
    POLLINATIONS_API_KEY=... python3 tools/generate-bank.py

Outputs (written to the repository root):
    bank_raw_v1.json   - raw generations incl. per-call usage
    data/bank.v1.json  - final playable bank
    bank_manifest.json - token totals (never contains API keys)

Notes:
- Prompts go to four models with one shared system prompt and a max_tokens cap.
- Answers that come back empty or leak a model/brand name are retried once;
  a prompt with a permanently failed slot is excluded from the final bank.
- Difficulty labels (easy/medium/hard) come from a Jaccard similarity pass
  over each prompt's four answers (v1 heuristic).
"""
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

KEY = os.environ.get('POLLINATIONS_API_KEY')
if not KEY:
    print('POLLINATIONS_API_KEY is required', file=sys.stderr)
    raise SystemExit(2)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
os.makedirs(DATA, exist_ok=True)

BANK_VERSION = '2026-10-09-v1'
MAX_TOKENS = 1500
SYS = 'You are an AI assistant. Answer directly. Never mention any AI model or company names.'

MODELS = [
    {'key': 'm1', 'apiModelId': 'openai/gpt-5.4-nano', 'displayName': 'GPT-5.4 Nano'},
    {'key': 'm2', 'apiModelId': 'anthropic/claude-sonnet-5.5', 'displayName': 'Claude Sonnet 5.5'},
    {'key': 'm3', 'apiModelId': 'google/gemini-3.8-flash', 'displayName': 'Gemini 3.8 Flash'},
    {'key': 'm4', 'apiModelId': 'z-ai/glm-5.3-flash', 'displayName': 'GLM 5.3 Flash'},
]

PROMPTS = [
    ('p01', 'explanation', 'Explain what an API is to a curious 12-year-old. Under 55 words.'),
    ('p02', 'explanation', 'Explain why the sky is blue to a 10-year-old. Under 60 words.'),
    ('p03', 'explanation', 'What is prompt caching? Explain in under 55 words.'),
    ('p04', 'explanation', 'Explain compound interest in two sentences.'),
    ('p05', 'advice', 'Give three practical tips for someone overwhelmed by notifications. Under 55 words.'),
    ('p06', 'advice', 'Someone keeps missing gym sessions. Give two realistic tips. Under 50 words.'),
    ('p07', 'advice', 'How do you say no to a meeting invite politely? Under 50 words.'),
    ('p08', 'advice', 'Best way to start learning to type faster? Three tips, under 55 words.'),
    ('p09', 'tradeoffs', 'A five-person team must choose between fixing bugs and adding features first. Answer in under 50 words.'),
    ('p10', 'tradeoffs', 'Should a small startup buy or build its analytics tool? Under 50 words.'),
    ('p11', 'tradeoffs', 'Is a monorepo or many repos better for a small team? Answer in under 50 words.'),
    ('p12', 'tradeoffs', 'Dark mode or light mode for long coding sessions? One short paragraph, under 50 words.'),
    ('p13', 'creative', 'Write a two-sentence scene: a robot waiting at a bus stop in the rain.'),
    ('p14', 'creative', 'Write a haiku about Monday mornings.'),
    ('p15', 'creative', 'Two sentences: a cat that runs a tiny bookstore.'),
    ('p16', 'creative', 'A two-line poem about coffee.'),
    ('p17', 'critique', "'If it compiles, it works.' Give a brief counterpoint in under 50 words."),
    ('p18', 'critique', "'Meetings are always a waste of time.' One counterexample, under 50 words."),
    ('p19', 'critique', "'AI will replace all programmers by 2030.' Brief critique, under 55 words."),
    ('p20', 'critique', "'Tests slow teams down.' Give one counterexample, under 50 words."),
    ('p21', 'rewrite', "Rewrite this in a friendlier tone: 'Your payment failed. Try again later.'"),
    ('p22', 'rewrite', "Make this clearer in one sentence: 'We have identified that the issue you reported is not reproducible on our environment at this time.'"),
    ('p23', 'rewrite', 'Summarize in one sentence: A home router manages traffic between your devices and the internet, assigning local addresses and forwarding requests, and it should be rebooted when the connection fails.'),
    ('p24', 'rewrite', 'Turn this into a checklist of three items: Before deploying, run tests, update the changelog, and notify the team.'),
]

NAME_LEAK = re.compile(r'(?i)\b(openai|chatgpt|gpt|claude|sonnet|anthropic|gemini|glm|grok|llama-?[0-9]*|mistral|mixtral|deepseek|qwen-?[0-9.]*|command[ -]?r|phi-[0-9])\b')


def normalize(text):
    text = (text or '').replace('\r', '').strip()
    text = re.sub(r'\n{3,}', '\n\n', text)
    text = re.sub(r'[ \t]+$', '', text, flags=re.M)
    return text.strip()


def call(model_id, prompt):
    body = {'model': model_id,
            'messages': [{'role': 'system', 'content': SYS}, {'role': 'user', 'content': prompt}],
            'max_tokens': MAX_TOKENS}
    req = urllib.request.Request('https://gen.pollinations.ai/v1/chat/completions',
                                 data=json.dumps(body).encode('utf-8'),
                                 headers={'Authorization': 'Bearer ' + KEY,
                                          'Content-Type': 'application/json',
                                          'User-Agent': 'model-match-bankgen'},
                                 method='POST')
    try:
        with urllib.request.urlopen(req, timeout=240) as r:
            d = json.load(r)
        text = ((d.get('choices') or [{}])[0].get('message') or {}).get('content') or ''
        return normalize(text), (d.get('usage') or {}), None
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', 'replace')[:140]
        except Exception:
            pass
        return '', {}, 'HTTP %s %s' % (e.code, body)
    except Exception as e:  # noqa: BLE001
        return '', {}, repr(e)[:120]


def main():
    raw = []
    for pid, cat, text in PROMPTS:
        row = {'id': pid, 'category': cat, 'text': text, 'answers': {}}
        for m in MODELS:
            got = None
            for _ in range(2):
                out, usage, err = call(m['apiModelId'], text)
                if err:
                    time.sleep(4)
                    continue
                if len(out) < 20 or NAME_LEAK.search(out):
                    time.sleep(2)
                    continue
                got = {'text': out, 'usage': usage}
                break
            if got is None:
                print('%s %s FAILED' % (pid, m['key']), flush=True)
            else:
                row['answers'][m['key']] = got
                print('%s %s ok' % (pid, m['key']), flush=True)
            time.sleep(0.3)
        row['complete'] = len(row['answers']) == len(MODELS)
        raw.append(row)

    with io.open(os.path.join(ROOT, 'bank_raw_v1.json'), 'w', encoding='utf-8') as f:
        json.dump({'bankVersion': BANK_VERSION, 'models': MODELS, 'prompts': raw}, f, ensure_ascii=False, indent=1)

    def words(t):
        return set(re.findall(r'[a-z0-9]+', t.lower()))

    scored = []
    for r in raw:
        if not r['complete']:
            continue
        ws = [words(r['answers'][m['key']]['text']) for m in MODELS]
        sims = []
        for i in range(len(ws)):
            for j in range(i + 1, len(ws)):
                inter = len(ws[i] & ws[j])
                union = len(ws[i] | ws[j]) or 1
                sims.append(inter / union)
        r['_sim'] = sum(sims) / len(sims)
        scored.append(r)

    scored.sort(key=lambda x: x['_sim'])
    n = len(scored)
    for idx, r in enumerate(scored):
        r['difficulty'] = 'easy' if idx < n / 3 else ('hard' if idx >= 2 * n / 3 else 'medium')

    style_notes = {
        'm1': ['Tends to be terse and factual in these samples; often a single tight paragraph or a clean numbered list.',
               'Rarely uses bold text or headings.'],
        'm2': ['Often uses bold lead-ins and tidy lists.',
               'Warm, polished phrasing with a practical closing note.'],
        'm3': ['Reaches for vivid metaphors and sensory detail.',
               'Longer, flowing sentences with emphatic dashes.'],
        'm4': ['Compact, metaphor-first answers ("Imagine a ...").',
               'Moves quickly to a clear recommendation.'],
    }

    bank = {
        'schemaVersion': 1,
        'bankVersion': BANK_VERSION,
        'language': 'en',
        'source': {'provider': 'pollinations', 'generationMode': 'build-time',
                   'runtimeApiCalls': False,
                   'modelList': [m['apiModelId'] for m in MODELS],
                   'generatedOn': time.strftime('%Y-%m-%d')},
        'models': [dict(m, styleNotes=style_notes[m['key']]) for m in MODELS],
        'prompts': [],
    }
    for r in scored:
        bank['prompts'].append({
            'id': r['id'], 'category': r['category'], 'difficulty': r['difficulty'], 'text': r['text'],
            'answers': [{'id': '%s-%s' % (r['id'], m['key']), 'modelKey': m['key'],
                         'text': r['answers'][m['key']]['text']} for m in MODELS],
        })

    with io.open(os.path.join(DATA, 'bank.v1.json'), 'w', encoding='utf-8') as f:
        json.dump(bank, f, ensure_ascii=False, indent=1)

    totals = {'input': 0, 'output': 0, 'perModel': {}}
    for r in raw:
        for mk, a in r.get('answers', {}).items():
            u = a.get('usage') or {}
            ti = u.get('prompt_tokens') or 0
            to = u.get('completion_tokens') or 0
            totals['input'] += ti
            totals['output'] += to
            pm = totals['perModel'].setdefault(mk, {'in': 0, 'out': 0, 'calls': 0})
            pm['in'] += ti
            pm['out'] += to
            pm['calls'] += 1

    manifest = {
        'bankVersion': BANK_VERSION,
        'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
        'api': 'gen.pollinations.ai/v1/chat/completions',
        'maxTokens': MAX_TOKENS,
        'systemPrompt': SYS,
        'models': MODELS,
        'promptsTotal': len(PROMPTS),
        'promptsComplete': sum(1 for r in raw if r['complete']),
        'tokens': totals,
        'note': 'API keys are never written to any output file.',
    }
    with io.open(os.path.join(ROOT, 'bank_manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    print('done: %d prompts in bank.v1.json' % len(bank['prompts']))


if __name__ == '__main__':
    main()
