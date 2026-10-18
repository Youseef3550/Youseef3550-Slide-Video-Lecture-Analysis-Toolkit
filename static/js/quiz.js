// quiz.js - Quiz tab: generate, answer, grade, review weak chapters, and delete quizzes.
// Talks to the /api/quiz endpoints in quiz_routes.py.

import { state } from './main.js';

const API = '/api/quiz';
let currentQuiz = null;
let chaptersCache = { videoId: null, chapters: [] };

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
}

function setStatus(text, kind = '') {
    const node = $('quizStatus');
    if (!node) return;
    node.textContent = text;
    node.className = `quiz-status ${kind}`.trim();
}

async function request(url, options = {}) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(typeof data.detail === 'string' ? data.detail : `Request failed (${res.status})`);
    }
    return data;
}

function postJson(url, body) {
    return request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function clockToSeconds(clock) {
    return String(clock).split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function seekTo(clock) {
    const player = $('videoPlayer');
    if (!player) return;
    player.currentTime = clockToSeconds(clock);
    player.play().catch(() => {});
}

// ---------- scope list (chapters and sections) ----------

async function refreshScopes() {
    const videoId = state.currentVideoId;
    const select = $('quizScope');
    if (!select) return;
    select.replaceChildren(el('option', { value: 'full', text: 'Full lecture' }));
    if (!videoId) return;

    if (chaptersCache.videoId !== videoId) {
        try {
            const res = await fetch(`/static/summaries/${encodeURIComponent(videoId)}.json`);
            chaptersCache = { videoId, chapters: res.ok ? await res.json() : [] };
        } catch {
            chaptersCache = { videoId, chapters: [] };
        }
    }

    chaptersCache.chapters.forEach((chapter, i) => {
        select.append(el('option', { value: `chapter:${i}`, text: `${chapter.timestamp}  ${chapter.title}` }));
        (chapter.sections || []).forEach((section, j) => {
            select.append(el('option', { value: `section:${i}:${j}`, text: `    ${section.timestamp}  ${section.title}` }));
        });
    });
}

function scopeToBody(value) {
    const [kind, a, b] = value.split(':');
    if (kind === 'chapter') return { scope_type: 'chapter', chapter_index: Number(a) };
    if (kind === 'section') return { scope_type: 'section', chapter_index: Number(a), section_index: Number(b) };
    return { scope_type: 'full' };
}

// ---------- saved quizzes ----------

async function refreshSaved() {
    const videoId = state.currentVideoId;
    const select = $('quizSaved');
    if (!select) return;
    select.replaceChildren(el('option', { value: '', text: 'Saved quizzes' }));
    if (!videoId) return;
    try {
        const items = await request(`${API}/list?video_id=${encodeURIComponent(videoId)}`);
        items.forEach((item) => {
            const when = new Date(item.created_at).toLocaleString();
            const level = item.bloom ? ` · ${item.bloom}` : '';
            select.append(el('option', {
                value: item.quiz_id,
                text: `${item.title} · ${item.question_count} q${level} · ${when}`,
            }));
        });
    } catch {
        // No saved quizzes yet is fine.
    }
}

async function loadSaved(quizId) {
    const videoId = state.currentVideoId;
    if (!quizId || !videoId) return;
    setStatus('Loading...');
    try {
        const quiz = await request(`${API}/${encodeURIComponent(quizId)}?video_id=${encodeURIComponent(videoId)}`);
        renderQuiz(quiz, videoId);
        setStatus(`Loaded: ${quiz.questions.length} questions`);
    } catch (err) {
        setStatus(err.message, 'error');
    }
}

// ---------- generate ----------

async function generateQuiz() {
    const videoId = state.currentVideoId;
    const btn = $('generateQuizBtn');
    if (!videoId) {
        setStatus('Open a video first.', 'error');
        return;
    }
    btn.disabled = true;
    setStatus('Generating... this can take 30 seconds or more.');
    try {
        const body = {
            video_id: videoId,
            ...scopeToBody($('quizScope').value),
            difficulty: $('quizDifficulty').value,
            bloom: $('quizBloom') ? $('quizBloom').value : 'understand',
            count: Number($('quizCount').value) || 6,
        };
        const quiz = await postJson(`${API}/generate`, body);
        renderQuiz(quiz, videoId);
        setStatus(`Ready: ${quiz.questions.length} questions`);
        refreshSaved();
    } catch (err) {
        setStatus(err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

// ---------- render ----------

function renderQuiz(quiz, videoId) {
    currentQuiz = { quiz, videoId };
    const container = $('quizContainer');
    container.replaceChildren();
    container.append(el('h3', { class: 'quiz-title', text: quiz.scope.title }));
    quiz.questions.forEach((q, index) => container.append(renderQuestion(q, index)));
    const submit = el('button', { class: 'btn btn-accent quiz-submit', type: 'button', text: 'Submit answers' });
    submit.addEventListener('click', submitQuiz);
    container.append(submit);
    container.append(el('div', { id: 'quizResults', class: 'quiz-summary' }));

    const del = $('deleteQuizBtn');
    if (del) del.disabled = false;
}

function renderQuestion(q, index) {
    const name = `answer-${q.id}`;
    const wrap = el('div', { class: 'quiz-question', 'data-qid': q.id });
    wrap.append(el('div', { class: 'quiz-q-head' }, [
        el('strong', { text: `${index + 1}. ` }),
        el('span', { text: q.question }),
    ]));

    if (q.type === 'mcq') {
        q.options.forEach((opt) => {
            wrap.append(el('label', { class: 'quiz-option' }, [
                el('input', { type: 'radio', name, value: opt.key }),
                el('span', { text: ` ${opt.key}) ${opt.text}` }),
            ]));
        });
    } else if (q.type === 'true_false') {
        [['true', 'True'], ['false', 'False']].forEach(([value, label]) => {
            wrap.append(el('label', { class: 'quiz-option' }, [
                el('input', { type: 'radio', name, value }),
                el('span', { text: ` ${label}` }),
            ]));
        });
    } else if (q.type === 'fill_in_blank') {
        wrap.append(el('input', { type: 'text', name, placeholder: 'Type the missing word' }));
    } else {
        wrap.append(el('textarea', { name, rows: '3', placeholder: 'Write your answer' }));
    }

    const source = el('button', {
        class: 'quiz-source',
        type: 'button',
        text: `Watch at ${q.source.timestamp}`,
    });
    source.addEventListener('click', () => seekTo(q.source.timestamp));
    wrap.append(source);
    wrap.append(el('div', { class: 'quiz-result', 'data-result': q.id }));
    return wrap;
}

function collectAnswers() {
    const answers = {};
    document.querySelectorAll('#quizContainer .quiz-question').forEach((wrap) => {
        const qid = wrap.dataset.qid;
        const checked = wrap.querySelector('input[type=radio]:checked');
        const text = wrap.querySelector('input[type=text], textarea');
        answers[qid] = checked ? checked.value : (text ? text.value.trim() : '');
    });
    return answers;
}

// ---------- submit, results, weak chapters ----------

async function submitQuiz() {
    if (!currentQuiz) return;
    const { quiz, videoId } = currentQuiz;
    const btn = document.querySelector('#quizContainer .quiz-submit');
    btn.disabled = true;
    setStatus('Grading... short answers are checked by AI.');
    try {
        const url = `${API}/${encodeURIComponent(quiz.quiz_id)}/submit?video_id=${encodeURIComponent(videoId)}`;
        const attempt = await postJson(url, { answers: collectAnswers() });
        showResults(attempt);
        renderReview(attempt);
        const grade = attempt.score.grade ? ` · Grade ${attempt.score.grade}` : '';
        setStatus(`Score: ${attempt.score.percentage}%${grade}`);
    } catch (err) {
        setStatus(err.message, 'error');
    } finally {
        btn.disabled = false;
    }
}

function showResults(attempt) {
    attempt.results.forEach((r) => {
        const box = document.querySelector(`#quizContainer [data-result="${r.question_id}"]`);
        if (!box) return;
        const mark = r.is_correct === null
            ? 'Not graded'
            : (r.is_correct ? 'Correct' : 'Wrong');
        box.replaceChildren(
            el('div', { class: 'quiz-mark', text: mark }),
            el('div', { text: r.feedback }),
        );
        if (r.missing_points && r.missing_points.length) {
            box.append(el('div', { class: 'quiz-missing', text: `Missing: ${r.missing_points.join('; ')}` }));
        }
        if (r.model_answer) {
            box.append(el('div', { class: 'quiz-model', text: `Model answer: ${r.model_answer}` }));
        }
    });

    const { percentage, grade, graded, total } = attempt.score;
    const gradeText = grade ? ` · Grade ${grade}` : '';
    $('quizResults').textContent = `Score: ${percentage}%${gradeText} (${graded} of ${total} graded)`;
}

function renderReview(attempt) {
    const results = $('quizResults');
    if (!results) return;
    const weak = attempt.weak_chapters || [];
    const recs = attempt.recommendations || [];
    if (!attempt.overall_feedback && !recs.length && !weak.length) return;

    const box = el('div', { class: 'quiz-weak' });
    if (attempt.overall_feedback) {
        box.append(el('strong', { text: 'Overall feedback' }));
        box.append(el('div', { text: attempt.overall_feedback }));
    }
    if (recs.length) {
        box.append(el('strong', { text: 'Study recommendations' }));
        const list = el('ul');
        recs.forEach((rec) => {
            const item = el('li');
            const jump = el('button', { class: 'quiz-source', type: 'button', text: `Watch at ${rec.timestamp}` });
            jump.addEventListener('click', () => seekTo(rec.timestamp));
            item.append(el('span', { text: `${rec.topic}: ${rec.reason} ` }), jump);
            list.append(item);
        });
        box.append(list);
    }
    if (weak.length) {
        box.append(el('strong', { text: 'Chapters to review' }));
        const list = el('ul');
        weak.forEach((w) => {
            list.append(el('li', {
                text: `${w.timestamp} ${w.title}: ${Math.round(w.average * 100)}% (${w.questions} questions)`,
            }));
        });
        box.append(list);
    }
    results.append(box);
}

// ---------- delete ----------

async function deleteQuiz() {
    if (!currentQuiz) return;
    const { quiz, videoId } = currentQuiz;
    if (!window.confirm('Delete this quiz and all of its attempts?')) return;
    try {
        await request(`${API}/${encodeURIComponent(quiz.quiz_id)}?video_id=${encodeURIComponent(videoId)}`, {
            method: 'DELETE',
        });
        currentQuiz = null;
        $('quizContainer').replaceChildren(el('p', { text: 'Quiz deleted.' }));
        $('deleteQuizBtn').disabled = true;
        setStatus('Deleted.');
        refreshSaved();
    } catch (err) {
        setStatus(err.message, 'error');
    }
}

// ---------- styles and setup ----------

function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
.quiz-controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
.quiz-question { border: 1px solid rgba(128, 128, 128, 0.35); border-radius: 8px; padding: 10px; margin-bottom: 10px; }
.quiz-q-head { margin-bottom: 6px; }
.quiz-option { display: block; margin: 4px 0; cursor: pointer; }
.quiz-question input[type=text], .quiz-question textarea { width: 100%; box-sizing: border-box; }
.quiz-source { background: none; border: none; color: inherit; text-decoration: underline; cursor: pointer; padding: 0; font-size: 12px; margin-top: 4px; }
.quiz-result { margin-top: 8px; font-size: 14px; }
.quiz-mark { font-weight: 600; margin-bottom: 4px; }
.quiz-missing, .quiz-model { margin-top: 4px; opacity: 0.85; }
.quiz-summary { margin-top: 10px; font-weight: 600; }
.quiz-weak { margin-top: 10px; padding: 10px; border: 1px solid rgba(255, 193, 7, 0.6); border-radius: 8px; font-weight: normal; }
.quiz-weak ul { margin: 6px 0 0 18px; }
.quiz-status { font-size: 13px; opacity: 0.85; }
.quiz-status.error { color: #ff6b6b; }
`;
    document.head.append(style);
}

function init() {
    const generate = $('generateQuizBtn');
    if (!generate) return;
    addStyles();
    generate.addEventListener('click', generateQuiz);
    $('quizSaved').addEventListener('change', (e) => loadSaved(e.target.value));
    const del = $('deleteQuizBtn');
    if (del) del.addEventListener('click', deleteQuiz);
    document.querySelector('.tab-btn[data-tab="quiz"]')?.addEventListener('click', () => {
        refreshScopes();
        refreshSaved();
    });
}

init();
