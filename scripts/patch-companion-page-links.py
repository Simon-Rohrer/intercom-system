#!/usr/bin/env python3
"""Version-checked JMS patch: keep fixed surface page links attached to their page.

Usage: python3 patch-companion-page-links.py ORIGINAL_MAIN_JS OUTPUT_MAIN_JS
Does not restart Companion or edit its database. Keep an original bundle for rollback.
"""
from pathlib import Path
import hashlib
import sys

BUILD = '5.0.0+9504-main-1dc10c6ea7'
ORIGINAL_SHA256 = '5374046509a493734cbfe511647e516f4da606721433affa4a42d3d4106f821a'
MARKER = 'JMS_PAGE_LINKS_V1'

# Uses the existing entity subscription and persistence paths, including nested
# actions/conditions, release actions, triggers and disabled actions.
REMAP_METHOD = '''
jmsRemapSurfacePageReferences(previousIds, nextIds) {
    const nextNumbers = new Map(nextIds.map((id, index) => [id, index + 1]));
    const changed = [];
    for (const entity of this.getAllEntities()) {
        if (entity.connectionId !== 'internal') continue;
        const supported = entity.type === 'action'
            ? ['set_page', 'set_page_byindex'].includes(entity.definitionId)
            : entity.type === 'feedback' && entity.definitionId === 'surface_on_page';
        const option = entity.rawOptions.page;
        if (!supported || !option || option.isExpression) continue;
        const raw = option.value;
        // Do not change dynamic/relative destinations, including string '+1'.
        if (!(typeof raw === 'number' || (typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw)))) continue;
        const number = Number(raw);
        if (!Number.isSafeInteger(number) || number < 1) continue;
        const targetId = previousIds[number - 1];
        if (!targetId) continue;
        const nextNumber = nextNumbers.get(targetId);
        if (nextNumber === number) continue;
        // A deleted target must never fall through to another page at that index.
        // This value is deliberately not numeric and cannot resolve to a page.
        const value = nextNumber === undefined ? 'deleted-page:' + targetId
            : typeof raw === 'string' ? String(nextNumber) : nextNumber;
        entity.setOption('page', { ...option, value });
        changed.push(entity);
    }
    if (changed.length) {
        this.tryTriggerLocalVariablesChanged(...changed);
        this.reportChange({ redraw: true, invalidateAllElements: true });
    }
}
'''

# Attach after PageStore has ensured that the default page exists. The old order
# is captured before every insert/delete/move and compared using stable page IDs.
LISTENER = '''
;/* JMS_PAGE_LINKS_V1 */
let jmsPageOrder = [...this.#i.getPageIds()];
this.#i.prependListener('pageindexchange', () => {
    const previousIds = jmsPageOrder;
    const nextIds = [...this.#i.getPageIds()];
    jmsPageOrder = nextIds;
    if (previousIds.length === nextIds.length && previousIds.every((id, index) => id === nextIds[index])) return;
    for (const control of this.#r.getAllControls().values()) {
        if (control.supportsEntities) control.entities.jmsRemapSurfacePageReferences(previousIds, nextIds);
    }
});
'''

def patch_bundle(source):
    if MARKER in source:
        raise ValueError('Already patched; refusing to apply twice')
    if hashlib.sha256(source.encode()).hexdigest() != ORIGINAL_SHA256:
        raise ValueError('Different Companion build or local modifications; review patch before applying')
    pool_anchor = 'getAllEntities(){return this.getAllEntityLists().flatMap(e=>e.getAllEntities())}'
    controller_anchor = 'this.#i._ensureDefaultPageExists()&&setImmediate(()=>{this.createPageDefaultNavButtons(1)})}createTrpcRouter()'
    for anchor in (pool_anchor, controller_anchor):
        if source.count(anchor) != 1:
            raise ValueError('Unsupported Companion bundle: anchor does not match exactly once')
    source = source.replace(pool_anchor, pool_anchor + REMAP_METHOD)
    source = source.replace(controller_anchor, controller_anchor.replace('}createTrpcRouter()', LISTENER + '}createTrpcRouter()'))
    return source

if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    original = Path(sys.argv[1]).read_text()
    result = patch_bundle(original)
    Path(sys.argv[2]).write_text(result)
    print('Patched Companion page links for', BUILD)
    print('Original SHA256:', hashlib.sha256(original.encode()).hexdigest())
    print('Patched SHA256:', hashlib.sha256(result.encode()).hexdigest())
