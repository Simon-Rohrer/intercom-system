import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

type ChatPopoutSectionProps = {
  children: ReactNode;
};

type ChatPopup = {
  container: HTMLDivElement;
};

const popupName = "kesher-chat";
const popupFeatures = "popup=yes,width=520,height=720,resizable=yes,scrollbars=yes";

function copyDocumentStyles(targetDocument: Document) {
  document
    .querySelectorAll('link[rel="stylesheet"], style')
    .forEach((styleNode) => {
      targetDocument.head.appendChild(
        targetDocument.importNode(styleNode, true),
      );
    });
}

function PopoutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

export function ChatPopoutSection({ children }: ChatPopoutSectionProps) {
  const popupRef = useRef<Window | null>(null);
  const [popup, setPopup] = useState<ChatPopup | null>(null);

  const closePopup = useCallback(() => {
    const currentPopup = popupRef.current;
    popupRef.current = null;
    setPopup(null);
    if (currentPopup && !currentPopup.closed) {
      currentPopup.close();
    }
  }, []);

  const openPopup = useCallback(() => {
    const currentPopup = popupRef.current;
    if (currentPopup && !currentPopup.closed) {
      currentPopup.focus();
      return;
    }

    const nextWindow = window.open("", popupName, popupFeatures);
    if (!nextWindow) {
      return;
    }

    popupRef.current = nextWindow;
    const popupDocument = nextWindow.document;
    popupDocument.documentElement.lang = document.documentElement.lang || "en";
    popupDocument.documentElement.className = "chat-popout-document";
    popupDocument.head.replaceChildren();
    popupDocument.title = "Chat - kesher";

    const base = popupDocument.createElement("base");
    base.href = document.baseURI;
    popupDocument.head.appendChild(base);

    const viewport = popupDocument.createElement("meta");
    viewport.name = "viewport";
    viewport.content =
      "width=device-width, initial-scale=1, viewport-fit=cover";
    popupDocument.head.appendChild(viewport);
    copyDocumentStyles(popupDocument);

    const container = popupDocument.createElement("div");
    container.id = "kesher-chat-popout-root";
    popupDocument.body.className = "chat-popout-body";
    popupDocument.body.replaceChildren(container);

    const handleBeforeUnload = () => {
      if (popupRef.current === nextWindow) {
        popupRef.current = null;
        setPopup(null);
      }
    };
    nextWindow.addEventListener("beforeunload", handleBeforeUnload, {
      once: true,
    });
    setPopup({ container });
    nextWindow.focus();
  }, []);

  useEffect(
    () => () => {
      const currentPopup = popupRef.current;
      popupRef.current = null;
      if (currentPopup && !currentPopup.closed) {
        currentPopup.close();
      }
    },
    [],
  );

  return (
    <>
      <section className="station-block station-utility station-utility-section">
        <div className="station-utility-heading">
          <h3>Chat</h3>
          <button
            type="button"
            className={`station-chat-popout-button ${popup ? "active" : ""}`}
            aria-label={
              popup
                ? "Focus chat window"
                : "Open chat in a separate window"
            }
            title={
              popup
                ? "Focus chat window"
                : "Open chat in a separate window"
            }
            onClick={openPopup}
          >
            <PopoutIcon />
          </button>
        </div>
        <div className="panel station-chat-panel">{children}</div>
      </section>

      {popup
        ? createPortal(
            <main className="chat-popout-shell">
              <header className="chat-popout-header">
                <h1>Chat</h1>
                <button
                  type="button"
                  className="chat-popout-close"
                  aria-label="Close chat window"
                  title="Close chat window"
                  onClick={closePopup}
                >
                  <CloseIcon />
                </button>
              </header>
              <div className="panel station-chat-panel chat-popout-panel">
                {children}
              </div>
            </main>,
            popup.container,
          )
        : null}
    </>
  );
}
