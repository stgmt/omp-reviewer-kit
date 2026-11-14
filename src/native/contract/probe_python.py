# One Python child that loads the module a pair lives in and walks the contract: build a record with
# the writer's own defaults (the parent supplies only the parameters without a default), hand it to
# the reader, and report what happened. A thrown error is the observation; the absence of one means
# the pair agrees on the record the writer actually produces.
#
# A module that imports its siblings relatively cannot be loaded from a file path, and that is
# reported as `module-failed` — never as agreement. Input is one JSON document on stdin, the answer
# one JSON document in the file the parent named.


import importlib.util
import inspect
import json
import os
import sys


def describe(error):
    return f"{type(error).__name__}: {error}"


def summarize(record):
    try:
        return json.dumps(record, default=str)[:400]
    except Exception:
        return '[unserializable]'


def load_module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'cannot load {path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main(request):
    root = request.get('root') or '.'
    if root not in sys.path:
        sys.path.insert(0, root)
    results = []
    loaded = {}

    def module_for(relative, index):
        if relative in loaded:
            return loaded[relative]
        path = relative if os.path.isabs(relative) else os.path.join(root, relative)
        loaded[relative] = load_module(path, f'review_kit_probe_{index}')
        return loaded[relative]

    for index, pair in enumerate(request.get('pairs', [])):
        writer_file = pair.get('writerFile') or pair.get('file') or ''
        reader_file = pair.get('readerFile') or pair.get('file') or ''
        try:
            writer_module = module_for(writer_file, index)
            reader_module = module_for(reader_file, index)
        except Exception as error:
            results.append({**pair, 'outcome': 'module-failed', 'error': describe(error)})
            continue
        writer = getattr(writer_module, pair.get('writer'), None)
        reader = getattr(reader_module, pair.get('reader'), None)
        if not callable(writer) or not callable(reader):
            results.append({**pair, 'outcome': 'not-exported', 'error': f"{pair.get('writer')}/{pair.get('reader')} are not both module-level functions"})
            continue
        if pair.get('crossModule'):
            # The reader must bind the writer this pair names: a bare import may resolve to a
            # different module, and a rejection from that other function is not this contract.
            binding = getattr(reader_module, pair.get('writer'), None)
            try:
                binding_source = inspect.getsourcefile(binding) if binding is not None else None
            except Exception:
                binding_source = None
            writer_path = writer_file if os.path.isabs(writer_file) else os.path.join(root, writer_file)
            if binding_source is None or os.path.realpath(binding_source) != os.path.realpath(writer_path):
                results.append({**pair, 'outcome': 'module-mismatch', 'error': f"{pair.get('writer')} in the reader binds {binding_source or 'nothing'}, not {writer_file}"})
                continue
        try:
            arguments = [slot.get('value') for slot in (pair.get('arguments') or [])]
            record = writer(*arguments)
        except Exception as error:
            results.append({**pair, 'outcome': 'writer-failed', 'error': describe(error)})
            continue
        try:
            reader(record)
            results.append({**pair, 'outcome': 'round-trip-ok', 'record': summarize(record)})
        except Exception as error:
            results.append({**pair, 'outcome': 'reader-rejects-written-record', 'error': describe(error), 'record': summarize(record)})
    return json.dumps({'results': results})


if __name__ == '__main__':
    request = {}
    try:
        request = json.loads(sys.stdin.read() or '{}')
        answer = main(request)
    except Exception as error:  # the child died before it could speak
        answer = json.dumps({'failed': describe(error)})
    target = request.get('answerFile') or os.environ.get('OMP_CONTRACT_ANSWER_FILE')
    if target:
        with open(target, 'w', encoding='utf-8') as handle:
            handle.write(answer)
    else:
        sys.stdout.write(answer)
