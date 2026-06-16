const migrateDynamicImageFeedbackOptions = (_context, props) => {
    const updatedFeedbacks = props.feedbacks.map((feedback) => {
        if (feedback.feedbackId !== "dynamic_button_image") {
            return feedback;
        }
        const nextOptions = { ...feedback.options };
        let changed = false;
        for (const deprecatedKey of [
            "displayMode",
            "effectColor",
            "effectValueOverride",
        ]) {
            if (deprecatedKey in nextOptions) {
                delete nextOptions[deprecatedKey];
                changed = true;
            }
        }
        if (!changed) {
            return feedback;
        }
        return {
            ...feedback,
            options: nextOptions,
        };
    });
    return {
        updatedConfig: props.config,
        updatedActions: props.actions,
        updatedFeedbacks,
    };
};
export const UpgradeScripts = [
    migrateDynamicImageFeedbackOptions,
];
